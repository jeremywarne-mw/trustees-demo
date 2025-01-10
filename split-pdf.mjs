import fs from 'fs/promises';
import path from 'path';
import PDFLib from 'pdf-lib';
import axios from 'axios';
import dotenv from 'dotenv';
import { buildHtmlReportPrompt, buildPdfExtractionPrompt } from './prompts.mjs';
import { getGptResponse, cache, saveCache, cachedPost } from './util.mjs';

dotenv.config();

const inputFile = process.argv[2];

// output folder is based on input file name

const outputFolder = path.join('./output', path.basename(inputFile, path.extname(inputFile)));

// Create folder if it doesn't exist

try {
    await fs.mkdir(outputFolder, { recursive: true });
}
catch (err) {
    console.error('Error creating output folder:', err);
}

const docIntelligenceEndpoint = process.env.DOC_INTELLIGENCE_ENDPOINT;
const docIntelligenceApiKey = process.env.DOC_INTELLIGENCE_API_KEY;
const docIntelligenceModelId = "prebuilt-document";
const docIntelligenceUrl = `${docIntelligenceEndpoint}formrecognizer/documentModels/${docIntelligenceModelId}:analyze?api-version=2023-07-31`;

async function analyzePdf(filePath) {
    if (cache[filePath]) {
        console.log("Using cached analysis result:");
        return cache[filePath];
    }

    const pdfData = await fs.readFile(filePath);

    try {
        const response = await axios.post(
            docIntelligenceUrl,
            pdfData,
            {
                headers: {
                    "Content-Type": "application/pdf",
                    "Ocp-Apim-Subscription-Key": docIntelligenceApiKey,
                },
            }
        );

        if (response.status === 202) {
            console.log("Analysis accepted. Polling for results...");
            const operationLocation = response.headers["operation-location"];
            
            // Step 2: Poll for results
            const result = await pollForResults(operationLocation);

            // Cache the response data
            cache[filePath] = result;

            saveCache();

            return result;
        } else {
            console.error("Unexpected response:", response.data);
        }

    } catch (error) {
        console.error("Error analyzing PDF:", error.response?.data || error.message);
    }
}

async function pollForResults(operationLocation) {
    const pollingInterval = 2000; // Poll every 2 seconds

    while (true) {
        try {
            const response = await axios.get(operationLocation, {
                headers: { "Ocp-Apim-Subscription-Key": docIntelligenceApiKey },
            });

            if (response.data.status === 'running') {
                console.log("Still processing... Waiting to retry.");
            } else if (response.data.status === 'succeeded') {
                return response.data;
            } else {
                console.error("Unexpected response:", response.data);
                break;
            }
        } catch (error) {
            console.error("Error during polling:", error.response?.data || error.message);
            break;
        }

        // Wait before polling again
        await new Promise(resolve => setTimeout(resolve, pollingInterval));
    }

    return null;
}

function readPage(page) {
    return `Page ${page.pageNumber}: \n\n` + page.lines.map((line) => line.content).join('\n');
}
  
async function analyzeAllPagesAndSplit(pages, outputDir) {
    const pageAnalysisResults = [];
    let lastPageSummary = null;
    const usedFilenames = new Set();

    for (let i = 0; i < pages.length; i += 9) {
        // Include the last page of the previous chunk as overlap
        const currentBatch = pages.slice(i, i + 10);
        const text = currentBatch.join("\n-------\n");

        const prompt = buildPdfExtractionPrompt(lastPageSummary, usedFilenames, text);

        try {
            const response = await getGptResponse(prompt)
            console.log("Response from GPT:", response);
            const analysis = JSON.parse(response);

            console.log("Analysis results:", analysis);

            // Add results and track used filenames
            pageAnalysisResults.push(...analysis);
            analysis.forEach(item => usedFilenames.add(item.filename));

            // Update the last page summary
            lastPageSummary = analysis[analysis.length - 1];
        } catch (error) {
            console.error("Error analyzing pages:", error.response?.data || error.message);
            break;
        }
    }

    // Split the PDF based on the analysis
    const pdfBytes = await fs.readFile(inputFile);
    const pdfDoc = await PDFLib.PDFDocument.load(pdfBytes);

    const splitFiles = await splitPdf(pdfDoc, pages, pageAnalysisResults, outputDir);

    // Generate a report from the analysis
    const report = await generateReport(pageAnalysisResults);

    return { splitFiles, report };
}

async function splitPdf(pdfDoc, textPages, analysisResults, outputDir) {
    const files = {};
    const metadata = {};

    for (const result of analysisResults) {
        const { pageNumber, filename, category, summary } = result;

        if (!files[filename]) {
            files[filename] = [];
        }
        files[filename].push(pageNumber);

        if (!metadata[filename]) {
            metadata[filename] = {};
        }
        if (!metadata[filename].category) {
            metadata[filename].category = category;
        }
        else {
            if (metadata[filename].category !== category) {
                console.error(`Category mismatch for ${filename}: ${metadata[filename].category} vs ${category}`);
            }
        }
        if (!metadata[filename].summary) {
            metadata[filename].summary = summary;
        }
    }

    let textComplete = "";

    // Create new PDFs based on the analysis
    const createdFiles = [];
    for (const [filename, pages] of Object.entries(files)) {
        const newPdfDoc = await PDFLib.PDFDocument.create();
        const textContent = [];
        for (const page of pages) {
            const [copiedPage] = await newPdfDoc.copyPages(pdfDoc, [page - 1]);
            newPdfDoc.addPage(copiedPage);

            // Add text content from the `pages` parameter
            textContent.push(`${textPages[page - 1]}`);

            textComplete += `${textPages[page - 1]}\n\n`;
        }
        const pdfBytes = await newPdfDoc.save();
        const outputPath = `${outputDir}/${filename}`;
        await fs.writeFile(outputPath, pdfBytes);
        createdFiles.push({ filename, outputPath, pages });

        // Write the plain text file
        const textFilePath = `${outputDir}/${filename.replace('.pdf', '_raw_ocr.txt')}`;
        await fs.writeFile(textFilePath, textContent.join('\n\n'), 'utf8');        
    }

    const completeTextFilePath = `${outputDir}/complete_raw_ocr.txt`;
    await fs.writeFile(completeTextFilePath, textComplete, 'utf8');

    // Create a manifest of all files, pulling from metadata

    const manifest = Object.entries(metadata).map(([filename, { category, summary }]) => ({ filename, category, summary }));
    const manifestFilePath = `${outputDir}/manifest.json`;
    await fs.writeFile(manifestFilePath, JSON.stringify(manifest, null, 2), 'utf8');

    return createdFiles;
}

async function generateReport(analysisResults) {
    const prompt = buildHtmlReportPrompt(analysisResults);

    const response = await getGptResponse(prompt);
    return response;
}

const result = await analyzePdf(inputFile);

const pages = result.analyzeResult.pages.map(readPage); // Extract text for all pages
const analysisResults = await analyzeAllPagesAndSplit(pages, outputFolder);

// Write analysisResults.report to a file

const reportFilePath = `${outputFolder}/report.html`;
await fs.writeFile(reportFilePath, analysisResults.report, 'utf8');



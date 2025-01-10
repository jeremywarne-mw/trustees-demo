import fs from 'fs/promises';
import path from 'path';
import { parse } from 'csv-parse/sync';
import axios from 'axios';
import { createObjectCsvWriter } from 'csv-writer';
import dotenv from 'dotenv';

// Load the cache from the file, or initialize it
let cache = {};
const cacheFilePath = './cache.json';

try {
    const data = await fs.readFile(cacheFilePath, 'utf8');
    cache = JSON.parse(data);
} catch (err) {
    if (err.code !== 'ENOENT') {
    console.error('Error loading cache:', err);
    }
}

dotenv.config();

const sourceFolder = process.argv[2];
const outputFolder = sourceFolder;

const azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT; // e.g., https://<resource-name>.openai.azure.com
const azureApiKey = process.env.AZURE_API_KEY;

/**
 * Save the cache to a file
 */
async function saveCache() {
    try {
        await fs.writeFile(cacheFilePath, JSON.stringify(cache, null, 2), 'utf-8');
    } catch (err) {
      console.error('Error saving cache file:', err);
    }
  }
  
  /**
   * Cached POST request with persistent cache
   * @param {string} url - The endpoint URL
   * @param {object} body - The request payload
   * @param {object} headers - The request headers
   * @returns {Promise<object>} - The response data
   */
  async function cachedPost(url, body, headers) {
    // Create a unique cache key based on the URL and payload
    const cacheKey = `${url}:${JSON.stringify(body)}`;
  
    // Return the cached response if available
    if (cache[cacheKey]) {
      return cache[cacheKey];
    }
    try {
      const response = await axios.post(url, body, { headers });
  
      // Cache the response data
      cache[cacheKey] = response.data;
  
      // Persist the cache to the file
      await saveCache();
  
      return response.data;
    } catch (err) {
      console.error('Error in cachedPost:', err);
      throw err;
    }
  }

const processText = async (filePath) => {
    const text = await fs.readFile(filePath, 'utf8');

    const prompt = `
        Respond in JSON format.

        Analyze the following text and respond with a JSON object containing the following fields:

        If it's a bank/credit card statement, add the following fields:
        1. startingBalance
        2. closingBalance
        3. csv: A CSV formatted string with headers: Date, Transaction Detail, Income, Expenditure, Skip. Enclose transaction detail in double quotes if it contains commas. Format expenditure and income as floats with no $ or , characters
        Skip should be true if the transaction is a transfer or a payment into a credit card account, or an opening or closing balance row.

        ---
        ${text}
    `;

    const headers = {
        'Content-Type': 'application/json',
        'api-key': azureApiKey,
    };

    const body = {
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1500,
        temperature: 0,
        top_p: 1,
    };

    const response = await cachedPost(`${azureEndpoint}`, body, headers);
    return JSON.parse(response.choices[0].message.content);
};

const writeCsv = async (data, outputPath) => {
    const csvWriter = createObjectCsvWriter({
        path: outputPath,
        header: [
            { id: 'Date', title: 'Date' },
            { id: 'TransactionDetail', title: 'Transaction Detail' },
            { id: 'Income', title: 'Income' },
            { id: 'Expenditure', title: 'Expenditure' },
            { id: 'Filename', title: 'File name' },
        ],
        alwaysQuote: true,
    });

    await csvWriter.writeRecords(data);
};


function parseCsvLine(line) {
    // Parse the line with csv-parse
    const records = parse(line.replace(/\s*(?=")|(?<=,)\s*/g, ''), {
      columns: false,
      skip_empty_lines: true,
    });
  
    // Return the parsed fields as an array
    return records[0];
  }

const processSourceFilesInFolder = async () => {
    try {
        await fs.mkdir(outputFolder, { recursive: true });

        const files = await fs.readdir(sourceFolder);
        
        const consolidatedData = [];
        let consolidatedHeaderRow = null; // Store the header row

        for (const file of files) {
            if (path.match(/_raw_ocr\.txt$/)) {
                console.log(`\n\n***********************\n\nProcessing: ${file}`);
                const filePath = path.join(sourceFolder, file);
                const result = await processText(filePath);

                const { category, startingBalance, closingBalance, csv } = result;

                const csvLines = csv?.split('\n');

                console.log(`Category: ${category}`);
                if (category.toLowerCase().includes('bank') || category.toLowerCase().includes('credit card')) {
                    console.log(`Starting Balance: ${startingBalance}`);
                    console.log(`Closing Balance: ${closingBalance}`);

                    // Extract header row and skip it in the data processing
                    const [headerRow, ...dataRows] = csvLines;

                    // Set the header row only once
                    if (!consolidatedHeaderRow) {
                        consolidatedHeaderRow = headerRow + ',Filename'; // Add a Filename column to the header
                    }

                    const csvData = dataRows.map((line) => {
                        if (!line.trim()) return null; // Skip empty lines

                        const [TransactionDate, TransactionDetail, Income, Expenditure, Skip] = parseCsvLine(line.replace(', "', ',"')); // Remove space after comma

                        if (Skip === 'true') return null; // Skip rows marked as transfers or opening/closing balances

                        return { 
                            Date: TransactionDate, // Parse the date for sorting
                            Filename: file,
                            TransactionDetail, Income, Expenditure, 
                        };
                    }).filter(Boolean); // Remove null entries

                    writeCsv(consolidatedData, path.join(outputFolder, `${file}.csv`));

                    consolidatedData.push(...csvData); // Add processed data rows to the consolidated array
                }
            }
        }

        // Sort consolidated data by the parsed Date field
        consolidatedData.sort((a, b) => new Date(a.Date) - new Date(b.Date));

        // Prepare sorted CSV data
        if (consolidatedHeaderRow && consolidatedData.length > 0) {
            writeCsv(consolidatedData, path.join(outputFolder, 'consolidated_statements.csv'));
        } else {
            console.log('No valid data to consolidate.');
        }

    } catch (error) {
        console.error('Error processing files:', error);
    }
};

processSourceFilesInFolder();

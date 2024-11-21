import fs from 'fs/promises';
import path from 'path';
import pdf from "pdf-parse";
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

const pdfFolder = './pdfs';
const outputFolder = './output';

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
      console.log('Cache hit');
      return cache[cacheKey];
    }
  
    console.log('Cache miss');
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

const processPdf = async (filePath) => {
    const data = await pdf(filePath);

    const { text } = data;

    console.log(text);

    const prompt = `
        Respond in JSON format.

        Analyze the following text and determine the category from among the following:
        
        Bank account statement
        Credit card statement
        Identification method
        Statutory declaration
        A letter from WINZ advising the breakdown of any benefit amount paid to you.
        A letter from WINZ declining your request for WINZ financial assistance
        Other supporting documentation
        Evidence of a debt payment plan
        A letter from a lending institution, who have declined a request from you for a financial loan.
        A payslip
        A copy of a letter from your employer informing you that your hours have been reduced
        A redundancy notice
        A rental agreement
        A rent arrears notice
        A mortgage arrears notice
        A mortgage statement
        A loan statement

        The response JSON should contain the category of the document in a field called "category".

        If it's a bank/credit card statement, add the following fields:
        1. startingBalance
        2. closingBalance
        3. csv: A CSV formatted string with headers: Date, Transaction Detail, Deposit, Withdrawal, Skip. Enclose transaction detail in double quotes if it contains commas. Format deposit and withdrawal as floats with no $ or , characters
        Skip should be true if the transaction is a transfer or credit card payment, or an opening or closing balance row.

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
    console.log(JSON.stringify(response.choices[0].message.content, null, 2));
    return JSON.parse(response.choices[0].message.content);
};

const writeCsv = async (data, outputPath) => {
    const csvWriter = createObjectCsvWriter({
        path: outputPath,
        header: [
            { id: 'Date', title: 'Date' },
            { id: 'TransactionDetail', title: 'Transaction Detail' },
            { id: 'Deposit', title: 'Deposit' },
            { id: 'Withdrawal', title: 'Withdrawal' },
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

const processPdfsInFolder = async () => {
    try {
        console.log('here');
        await fs.mkdir(outputFolder, { recursive: true });

        const files = await fs.readdir(pdfFolder);
        
        const consolidatedData = [];
        let consolidatedHeaderRow = null; // Store the header row

        for (const file of files) {
            if (path.extname(file).toLowerCase() === '.pdf') {
                console.log(`Processing: ${file}`);
                const filePath = path.join(pdfFolder, file);
                const result = await processPdf(filePath);

                const { category, startingBalance, closingBalance, csv } = result;

                const csvLines = csv.split('\n');

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

                        const [TransactionDate, TransactionDetail, Deposit, Withdrawal, Skip] = parseCsvLine(line.replace(', "', ',"')); // Remove space after comma

                        if (Skip === 'true') return null; // Skip rows marked as transfers or opening/closing balances

                        return { 
                            Date: TransactionDate, // Parse the date for sorting
                            Filename: file,
                            TransactionDetail, Deposit, Withdrawal, 
                        };
                    }).filter(Boolean); // Remove null entries

                    consolidatedData.push(...csvData); // Add processed data rows to the consolidated array
                } else {
                    console.log(`Skipping non-bank statement file: ${file}`);
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
        console.error('Error processing PDFs:', error);
    }
};

processPdfsInFolder();

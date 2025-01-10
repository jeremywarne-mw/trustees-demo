export function buildPdfExtractionPrompt(lastPageSummary, usedFilenames, text) {
    return `
            The following text is a number of pages from a concatenated PDF. The objective is to separate the PDF into individual documents and categorize them.
            Your response should be a JSON array of objects matching the following schema:
            {
                "pageNumber": {{ current page number}},
                "category": "{{ choose from the list below }}",
                "confidence": "{{ an integer between 0 and 5 indicating the confidence level of the categorisation }}",
                "filename": "{{ rules explained below }}",
                "summary": "{{ An independent description of the content of the page. This must not relate to or use data from any of the other pages in the batch. }}",
                "statedPageNumber": "{{ The page number as stated in the text of the page, if any, and the total number of pages stated, if any }}"
            }
            
            If the text of the page contains numbering ("eg. Page 1 of 5"), this should be used as the primary indication of whether a page is part of a new document.

            If the page number matches the "last page summary from previous run", it's there just for context to determine whether the next page is a new document or not -- if this is true, don't include this page in the output and use it only for context. 

            If the page is part of the previous document, you must use the same filename for it. If it's the start of a new document, choose a descriptive, semantic name for the pdf document which hasn't been used before -- avoid just using category_1, category_2 etc. Where a file appears to be a statement for a date range, describe the months covered in the filename, and use the bank name and account type rather than "Bank" 

            Determine the category from among the following:

            Financial hardship Kiwisaver withdrawal form
            Bank account statement
            Kiwisaver statement
            Credit card statement   
            Identification method
            Statutory declaration
            A letter from WINZ advising the breakdown of any benefit amount paid to you.
            A letter from WINZ declining your request for WINZ financial assistance
            Evidence of unexpected expenses
            Evidence of a debt payment plan
            A letter from a lending institution, who have declined a request from you for a financial loan.
            A payslip
            A letter providing evidence of a change of employment or income
            A rental agreement
            A rent arrears notice
            A mortgage or other payment arrears notice
            A mortgage statement
            A loan statement
            Other supporting documentation
            
            Last page summary from previous run:
            ${lastPageSummary ? JSON.stringify(lastPageSummary, null, 2) : "No previous summary available"}

            Previously used filenames:
            ${JSON.stringify(Array.from(usedFilenames), null, 2)}

            ---
            ${text}
        `;
}export function buildHtmlReportPrompt(analysisResults) {
    return `
        The following is a JSON summary of the analysis results and the newly created files based on the split:
        ${JSON.stringify(analysisResults, null, 2)}

        Please produce an HTML report listing each file name, the category and page range of the file, and a summary of the content, for all files. 
    `;
}


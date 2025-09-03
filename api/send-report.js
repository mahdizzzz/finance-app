// /api/send-report.js - Vercel Serverless Function

const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const os = require('os'); // Needed for the temporary directory

// --- CONFIGURATION ---
// These will be read from Vercel's Environment Variables, NOT directly from the code.
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
// -------------------

// This is the main function that Vercel will run.
export default async function handler(req, res) {
    // We only accept POST requests
    if (req.method !== 'POST') {
        return res.status(405).json({ message: 'Only POST requests are allowed' });
    }
    
    // Check for essential environment variables
    if (!TOKEN || !CHAT_ID) {
        console.error("Server Error: Telegram token or chat ID is not configured.");
        return res.status(500).json({ ok: false, message: "Server configuration error." });
    }
    
    // Initialize the bot inside the handler
    const bot = new TelegramBot(TOKEN);
    
    try {
        const { htmlContent, fileName } = req.body;

        if (!htmlContent || !fileName) {
            console.error("Error: Report information is incomplete.");
            return res.status(400).json({ ok: false, message: "Bad Request: Missing report data." });
        }
        
        // Vercel allows writing to the /tmp directory
        const tempFilePath = path.join(os.tmpdir(), fileName);
        
        // Use promises for writing file to handle async operations cleanly
        await fs.promises.writeFile(tempFilePath, htmlContent);

        console.log(`Sending file ${fileName} to Telegram...`);
        
        await bot.sendDocument(CHAT_ID, tempFilePath, { caption: 'Your Financial Report' });
        
        console.log("File sent successfully!");

        // Clean up the temporary file
        await fs.promises.unlink(tempFilePath);
        console.log("Temporary file deleted.");

        // Send a success response back to the browser
        res.status(200).json({ ok: true, message: "Report sent to Telegram!" });

    } catch (error) {
        console.error("An error occurred:", error.message);
        // Provide a more specific error for debugging if possible
        let errorMessage = "An internal server error occurred.";
        if (error.response && error.response.body) {
            // Error from Telegram API
            errorMessage = `Telegram API Error: ${error.response.body.description}`;
            console.error("Telegram Error Body:", error.response.body);
        }
        res.status(500).json({ ok: false, message: errorMessage });
    }
}


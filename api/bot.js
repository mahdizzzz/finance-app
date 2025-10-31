// /api/bot.js - Serverless Function for Telegram Bot Webhook with Gemini AI

import { Telegraf } from 'telegraf';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { GoogleGenerativeAI } from '@google/generative-ai';

// --- CONFIGURATION ---
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const FIREBASE_USER_ID = process.env.FIREBASE_USER_ID;

let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_CONFIG);
} catch (e) {
  console.error('Error parsing FIREBASE_ADMIN_CONFIG:', e.message);
}

// --- INITIALIZE SERVICES ---

// Initialize Firebase Admin
if (!getApps().length) {
  try {
    initializeApp({
      credential: cert(serviceAccount)
    });
  } catch (e) {
     console.error('Firebase Admin initialization error:', e.message);
  }
}

// Initialize Gemini
let genAI, geminiModel;
if (GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  geminiModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash-preview-09-2025"});
} else {
  console.error("Gemini API Key is not set.");
}

const db = getFirestore();
const bot = new Telegraf(BOT_TOKEN);

// --- SECURITY CHECK ---
bot.use((ctx, next) => {
  const userId = ctx.from?.id.toString();
  if (userId === CHAT_ID) {
    return next(); // You are authorized
  }
  console.warn(`Unauthorized access attempt by user ID: ${userId}`);
  return ctx.reply('شما مجاز به استفاده از این ربات نیستید.');
});

// --- HELPER FUNCTIONS ---

const formatCurrency = (num) => new Intl.NumberFormat('fa-IR').format(num);

const getTodayDateRange = () => {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  return {
    start: Timestamp.fromDate(today),
    end: Timestamp.fromDate(tomorrow)
  };
};

const getThisMonthDateRange = () => {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    return {
        start: Timestamp.fromDate(startOfMonth),
        end: Timestamp.fromDate(endOfMonth)
    };
};


// --- GEMINI AI LOGIC ---

// --- FIX: Updated and stricter prompt ---
const GEMINI_PROMPT = `
شما یک ربات تحلیلگر متن مالی به زبان فارسی هستید.
وظیفه شما فقط و فقط خروجی دادن JSON است.
متن ورودی کاربر را بخوانید و آن را به یکی از 3 ساختار JSON زیر تبدیل کنید.

1.  **ثبت تراکنش**:
    {
      "intent": "add_transaction",
      "transaction": { "type": "expense" | "income", "amount": [number], "description": "[string]" }
    }
    مثال ها:
    - ورودی: "امروز یه قهوه خریدم ۵۰ تومن" -> خروجی: {"intent":"add_transaction", "transaction": {"type":"expense", "amount": 50000, "description":"قهوه"}}
    - ورودی: "۱۵۰ هزار تومن بابت فلش گرفتم" -> خروجی: {"intent":"add_transaction", "transaction": {"type":"income", "amount": 150000, "description":"فلش"}}

2.  **درخواست گزارش**:
    {
      "intent": "get_report",
      "report": { "type": "expense" | "income" | "all", "period": "today" | "month" | "all_time" }
    }
    مثال ها:
    - ورودی: "امروز چقدر خرج کردم؟" -> خروجی: {"intent":"get_report", "report": {"type":"expense", "period":"today"}}
    - ورودی: "میزان خرج این ماهم رو بگو" -> خروجی: {"intent":"get_report", "report": {"type":"expense", "period":"month"}}

3.  **نامفهوم**:
    {
      "intent": "unrecognized"
    }
    مثال ها:
    - ورودی: "سلام خوبی؟" -> خروجی: {"intent":"unrecognized"}
    - ورودی: "تست" -> خروجی: {"intent":"unrecognized"}
    - ورودی: "asdf" -> خروجی: {"intent":"unrecognized"}

**مهم: پاسخ شما باید *فقط* و *همیشه* یکی از این سه ساختار JSON باشد. هیچ متن اضافه ای نفرستید.**
`;

// --- FIX: Changed to generateContent and using systemInstruction ---
async function getGeminiAnalysis(text) {
  if (!geminiModel) {
    throw new Error("Gemini Model is not initialized.");
  }
  
  let jsonText = ""; // Initialize empty string
  try {
    // 1. Try to get response from Gemini
    const result = await geminiModel.generateContent({
        contents: [{ role: "user", parts: [{ text: text }] }],
        systemInstruction: {
            parts: [{ text: GEMINI_PROMPT }]
        },
        generationConfig: { maxOutputTokens: 100, responseMimeType: "application/json" },
    });
    
    const response = await result.response;
    jsonText = response.text();

    // 2. Check if the response is empty
    if (!jsonText) {
        console.warn("Gemini returned an empty string.");
        return { intent: "unrecognized" }; // Return unrecognized if response is empty
    }

    // 3. Try to parse the JSON
    return JSON.parse(jsonText);

  } catch (error) {
    // This will catch errors from Gemini API (network) AND JSON.parse()
    console.error("Error in getGeminiAnalysis (network or parse):", error);
    
    // Check if it was a JSON parse error specifically
    if (error instanceof SyntaxError) {
        console.warn("Gemini returned non-JSON text:", jsonText);
        return { intent: "unrecognized" }; // Return unrecognized if it's just bad JSON
    }
    
    // Otherwise, it was a more serious network/API error
    return null; // Return null to signify a major error
  }
}

// --- DATABASE LOGIC ---

async function addTransaction(transactionData) {
  const newTransaction = {
      ...transactionData,
      category: 'سایر', // Default category for bot entries
      date: new Date().toISOString().split('T')[0], // Today's date
      time: new Date().toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' }),
      createdAt: Timestamp.now(), // Use server timestamp
  };

  const docRef = await db.collection('users').doc(FIREBASE_USER_ID).collection('transactions').add(newTransaction);
  return newTransaction;
}

async function getReport(reportRequest) {
    let { type, period } = reportRequest;
    let queryRef = db.collection('users').doc(FIREBASE_USER_ID).collection('transactions');
    
    let dateRange;
    let periodText = "";
    if (period === 'today') {
        dateRange = getTodayDateRange();
        queryRef = queryRef.where('createdAt', '>=', dateRange.start).where('createdAt', '<', dateRange.end);
        periodText = "امروز";
    } else if (period === 'month') {
        dateRange = getThisMonthDateRange();
        queryRef = queryRef.where('createdAt', '>=', dateRange.start).where('createdAt', '<=', dateRange.end);
        periodText = "این ماه";
    }
    // 'all_time' needs no date filter

    let totalAmount = 0;
    let typeText = "";

    if (type === 'expense') {
        queryRef = queryRef.where('type', '==', 'expense');
        typeText = "خرج";
    } else if (type === 'income') {
        queryRef = queryRef.where('type', '==', 'income');
        typeText = "درآمد";
    } else {
        typeText = "تراز مالی";
    }

    const snapshot = await queryRef.get();

    snapshot.forEach(doc => {
        const data = doc.data();
        if (type === 'all') {
            totalAmount += (data.type === 'income' ? data.amount : -data.amount);
        } else {
            totalAmount += data.amount;
        }
    });

    return `مجموع ${typeText} شما در ${periodText}: ${formatCurrency(totalAmount)} تومان`;
}

// --- BOT HANDLERS ---

bot.start((ctx) => ctx.reply('سلام! من ربات هوشمند مالی شما هستم.\nمی‌توانید بنویسید: "امروز ۵۰ تومن قهوه خریدم" تا آن را ثبت کنم.\nیا بپرسید: "این ماه چقدر خرج کردم؟" تا به شما گزارش دهم.'));

// --- FIX: Improved response logic ---
bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    await ctx.replyWithChatAction('typing'); // Show "typing..." status

    try {
        const analysis = await getGeminiAnalysis(text); // Returns object, {intent: "unrecognized"}, or null

        if (analysis && analysis.intent === 'add_transaction') {
            // Case 1: Gemini understood and it's a transaction
            const newTransaction = await addTransaction(analysis.transaction);
            const typeText = newTransaction.type === 'income' ? 'درآمد' : 'هزینه';
            return ctx.reply(`✅ ثبت شد:\n${typeText} به مبلغ ${formatCurrency(newTransaction.amount)} تومان (${newTransaction.description})`);
        
        } else if (analysis && analysis.intent === 'get_report') {
            // Case 2: Gemini understood and it's a report request
            const reportMessage = await getReport(analysis.report);
            return ctx.reply(reportMessage);
        
        } else if (analysis === null) {
            // Case 3: A major error occurred (network, API key, etc.)
            return ctx.reply('خطایی در ارتباط با هوش مصنوعی رخ داد. لطفاً بعداً تلاش کنید.');
        
        } else {
            // Case 4: analysis is {intent: "unrecognized"} (Gemini didn't understand the text)
            return ctx.reply('متوجه پیام شما نشدم. لطفاً دوباره تلاش کنید (مثلاً: "هزینه 10000 تست" یا "خرج امروز؟")');
        }

    } catch (error) {
        // Case 5: Catch any other unexpected errors in the main logic
        console.error('Main Bot Error:', error);
        return ctx.reply('خطایی در سرور رخ داد. لطفاً بعداً تلاش کنید.');
    }
});

// --- VERCEL HANDLER ---
export default async (req, res) => {
    try {
        await bot.handleUpdate(req.body);
        res.status(200).send('OK');
    } catch (e) {
        console.error('Error handling update:', e.message);
        res.status(500).send('Error');
    }
};


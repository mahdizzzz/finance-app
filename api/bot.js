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
  geminiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest"});
} else {
  console.error("Gemini API Key is not set.");
}

const db = getFirestore();
const bot = new Telegraf(BOT_TOKEN);

// --- SECURITY CHECK ---
// Middleware to ensure only you can use this bot
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

// Get today's date range for Firestore queries
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

// Get this month's date range for Firestore queries
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

// This is the core prompt for Gemini
const GEMINI_PROMPT = `
شما یک دستیار هوشمند برای تحلیل پیام‌های مالی به زبان فارسی هستید.
وظیفه شما این است که متن پیام کاربر را دریافت کنید و آن را به یکی از دو ساختار JSON زیر تبدیل کنید:

1.  اگر پیام، یک **ثبت تراکنش** (هزینه یا درآمد) بود:
    {
      "intent": "add_transaction",
      "transaction": {
        "type": "expense" | "income",
        "amount": [number] (مبلغ به تومان),
        "description": "[string] (شرح تراکنش)"
      }
    }
    مثال:
    - ورودی: "امروز یه قهوه خریدم ۵۰ تومن" -> خروجی: {"intent":"add_transaction", "transaction": {"type":"expense", "amount": 50000, "description":"قهوه"}}
    - ورودی: "۱۵۰ هزار تومن بابت فلش گرفتم" -> خروجی: {"intent":"add_transaction", "transaction": {"type":"income", "amount": 150000, "description":"فلش"}}

2.  اگر پیام، یک **درخواست گزارش** (پرسش در مورد موجودی یا خرج) بود:
    {
      "intent": "get_report",
      "report": {
        "type": "expense" | "income" | "all",
        "period": "today" | "month" | "all_time"
      }
    }
    مثال:
    - ورودی: "امروز چقدر خرج کردم؟" -> خروجی: {"intent":"get_report", "report": {"type":"expense", "period":"today"}}
    - ورودی: "میزان خرج این ماهم رو بگو" -> خروجی: {"intent":"get_report", "report": {"type":"expense", "period":"month"}}
    - ورودی: "درآمد امروزم چقدر بود؟" -> خروجی: {"intent":"get_report", "report": {"type":"income", "period":"today"}}

اگر پیام قابل درک نبود یا به این دو دسته تعلق نداشت، فقط یک JSON خالی برگردان: {}
`;

async function getGeminiAnalysis(text) {
  if (!geminiModel) {
      throw new Error("Gemini Model is not initialized.");
  }
  try {
    const chat = geminiModel.startChat({
        history: [{ role: "user", parts: [{ text: GEMINI_PROMPT }] }],
        generationConfig: { maxOutputTokens: 100, responseMimeType: "application/json" },
    });
    const result = await chat.sendMessage(text);
    const response = await result.response;
    const jsonText = response.text();
    return JSON.parse(jsonText);
  } catch (error) {
    console.error("Error communicating with Gemini:", error);
    return null;
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

bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    await ctx.replyWithChatAction('typing'); // Show "typing..." status

    try {
        const analysis = await getGeminiAnalysis(text);

        if (analysis && analysis.intent === 'add_transaction') {
            const newTransaction = await addTransaction(analysis.transaction);
            const typeText = newTransaction.type === 'income' ? 'درآمد' : 'هزینه';
            return ctx.reply(`✅ ثبت شد:\n${typeText} به مبلغ ${formatCurrency(newTransaction.amount)} تومان (${newTransaction.description})`);
        
        } else if (analysis && analysis.intent === 'get_report') {
            const reportMessage = await getReport(analysis.report);
            return ctx.reply(reportMessage);
        
        } else {
            return ctx.reply('متوجه پیام شما نشدم. لطفاً دوباره تلاش کنید (مثلاً: "هزینه 10000 تست" یا "خرج امروز؟")');
        }

    } catch (error) {
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


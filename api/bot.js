// /api/bot.js - Serverless Function for Telegram Bot Webhook with Gemini AI

import { Telegraf } from 'telegraf';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, Timestamp, doc, setDoc, getDoc, collection, getDocs } from 'firebase-admin/firestore';
import { GoogleGenerativeAI } from '@google/generative-ai';

// --- CONFIGURATION ---
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const FIREBASE_USER_ID = process.env.FIREBASE_USER_ID;

// Define valid categories (must match your web app)
const VALID_CATEGORIES = {
    income: ['فلش', 'فیلترشکن', 'اینستاگرام', 'اپل آیدی', 'همکار', 'سایر'],
    expense: ['خوراک', 'پوشاک', 'قهوه', 'قسط', 'سایر']
};


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

// --- FIX: Added Account Balance intents (update_balance, get_balance) ---
const GEMINI_PROMPT = `
شما یک ربات تحلیلگر متن مالی به زبان فارسی هستید.
وظیفه شما فقط و فقط خروجی دادن JSON است.
متن ورودی کاربر را بخوانید و آن را به یکی از 5 ساختار JSON زیر تبدیل کنید.

لیست دسته‌بندی‌های مجاز برای تراکنش‌ها:
- هزینه (expense): ${JSON.stringify(VALID_CATEGORIES.expense)}
- درآمد (income): ${JSON.stringify(VALID_CATEGORIES.income)}

1.  **ثبت تراکنش**:
    {
      "intent": "add_transaction",
      "transaction": { "type": "expense" | "income", "amount": [number], "description": "[string]", "category": "[string]" }
    }
    مثال:
    - ورودی: "خرید تیشرت و شلوار 5 میلیون" -> خروجی: {"intent":"add_transaction", "transaction": {"type":"expense", "amount": 5000000, "description":"خرید تیشرت و شلوار", "category": "پوشاک"}}

2.  **درخواست گزارش تراکنش**:
    {
      "intent": "get_report",
      "report": { "type": "expense" | "income" | "all", "period": "today" | "month" | "all_time" }
    }
    مثال:
    - ورودی: "امروز چقدر خرج کردم؟" -> خروجی: {"intent":"get_report", "report": {"type":"expense", "period":"today"}}

3.  **ثبت یا به‌روزرسانی موجودی حساب**:
    {
      "intent": "update_balance",
      "account": {
        "name": "[string] (نام حساب/بانک)",
        "balance": [number] (مبلغ موجودی به تومان)
      }
    }
    مثال:
    - ورودی: "موجودی بانک ملی من ۵ میلیون است" -> خروجی: {"intent":"update_balance", "account": {"name": "بانک ملی", "balance": 5000000}}
    - ورودی: "موجودی کیف پولم 250 هزار تومنه" -> خروجی: {"intent":"update_balance", "account": {"name": "کیف پول", "balance": 250000}}

4.  **درخواست موجودی حساب**:
    {
      "intent": "get_balance",
      "account": {
        "name": "[string] (نام حساب/بانک یا "all" برای همه)"
      }
    }
    مثال:
    - ورودی: "موجودی‌هام چقدره؟" -> خروجی: {"intent":"get_balance", "account": {"name": "all"}}
    - ورودی: "موجودی بانک ملی چنده؟" -> خروجی: {"intent":"get_balance", "account": {"name": "بانک ملی"}}

5.  **نامفهوم**:
    {
      "intent": "unrecognized"
    }
    مثال:
    - ورودی: "سلام خوبی؟" -> خروجی: {"intent":"unrecognized"}

**مهم: پاسخ شما باید *فقط* و *همیشه* یکی از این ساختارها باشد.**
`;

async function getGeminiAnalysis(text) {
  if (!geminiModel) {
    throw new Error("Gemini Model is not initialized.");
  }
  
  let jsonText = "";
  try {
    const chat = geminiModel.startChat({
        history: [
            { role: "user", parts: [{ text: GEMINI_PROMPT }] },
            { role: "model", parts: [{ text: "{\n  \"intent\": \"unrecognized\"\n}" }] }
        ],
        generationConfig: { maxOutputTokens: 200 }, // Increased token size
    });
    
    const result = await chat.sendMessage(text);
    const response = await result.response;

    if (response.promptFeedback && response.promptFeedback.blockReason) {
        console.warn(`Gemini blocked the prompt. Reason: ${response.promptFeedback.blockReason}`);
        return { intent: "unrecognized" };
    }
    if (response.candidates && response.candidates[0].finishReason !== 'STOP') {
        console.warn(`Gemini did not finish. Reason: ${response.candidates[0].finishReason}`);
        return { intent: "unrecognized" };
    }

    jsonText = response.text();
    if (!jsonText) {
        console.warn("Gemini returned an empty string.");
        return { intent: "unrecognized" };
    }

    if (jsonText.startsWith("```json")) {
      jsonText = jsonText.substring(7, jsonText.length - 3);
    }
    
    return JSON.parse(jsonText);

  } catch (error) {
    console.error("Error in getGeminiAnalysis (network or parse):", error);
    if (error instanceof SyntaxError) {
        console.warn("Gemini returned non-JSON text:", jsonText);
        return { intent: "unrecognized" };
    }
    return null; // Major error
  }
}

// --- DATABASE LOGIC ---

async function addTransaction(transactionData) {
  const newTransaction = {
      type: transactionData.type,
      amount: transactionData.amount,
      description: transactionData.description,
      category: transactionData.category || 'سایر',
      date: new Date().toISOString().split('T')[0],
      time: new Date().toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' }),
      createdAt: Timestamp.now(),
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

// --- NEW ACCOUNT BALANCE FUNCTIONS ---

async function updateAccountBalance(accountData) {
    // Use the account name as the document ID for easy overwrites
    const docRef = doc(db, 'users', FIREBASE_USER_ID, 'accounts', accountData.name);
    await setDoc(docRef, { 
        name: accountData.name, // Store name too for easier fetching
        balance: accountData.balance,
        updatedAt: Timestamp.now()
    }, { merge: true }); // Merge ensures we don't overwrite other fields if they exist
    return accountData;
}

async function getAccountBalances(accountRequest) {
    const accountName = accountRequest.name;
    const collectionRef = collection(db, 'users', FIREBASE_USER_ID, 'accounts');
    let message = "گزارش موجودی حساب‌ها:\n\n";

    if (accountName === 'all') {
        const snapshot = await getDocs(collectionRef);
        if (snapshot.empty) {
            return "هنوز هیچ حسابی ثبت نکرده‌اید. (مثال: موجودی بانک ملی 500000)";
        }
        let total = 0;
        snapshot.forEach(doc => {
            const data = doc.data();
            message += `🏦 ${data.name}: ${formatCurrency(data.balance)} تومان\n`;
            total += data.balance;
        });
        message += `\n**موجودی کل: ${formatCurrency(total)} تومان**`;
    } else {
        const docRef = doc(db, 'users', FIREBASE_USER_ID, 'accounts', accountName);
        const docSnap = await getDoc(docRef);
        if (!docSnap.exists()) {
            return `حسابی به نام "${accountName}" یافت نشد.`;
        }
        const data = docSnap.data();
        message = `🏦 موجودی ${data.name}: ${formatCurrency(data.balance)} تومان`;
    }
    return message;
}


// --- BOT HANDLERS ---

bot.start((ctx) => ctx.reply('سلام! من ربات هوشمند مالی شما هستم.\nمی‌توانید بنویسید: "امروز ۵۰ تومن قهوه خریدم" تا آن را ثبت کنم.\nیا بپرسید: "این ماه چقدر خرج کردم؟" تا به شما گزارش دهم.\nیا موجودی خود را ثبت کنید: "موجودی بانک ملی 1 میلیون تومان"'));

// --- FIX: Added new intents to the handler ---
bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    await ctx.replyWithChatAction('typing'); // Show "typing..." status

    try {
        const analysis = await getGeminiAnalysis(text); // Returns object, {intent: "unrecognized"}, or null

        if (analysis && analysis.intent === 'add_transaction') {
            // Case 1: Add Transaction
            const newTransaction = await addTransaction(analysis.transaction);
            const typeText = newTransaction.type === 'income' ? 'درآمد' : 'هزینه';
            return ctx.reply(`✅ ثبت شد:\n${typeText} به مبلغ ${formatCurrency(newTransaction.amount)} تومان\n(شرح: ${newTransaction.description} | دسته‌بندی: ${newTransaction.category})`);
        
        } else if (analysis && analysis.intent === 'get_report') {
            // Case 2: Get Transaction Report
            const reportMessage = await getReport(analysis.report);
            return ctx.reply(reportMessage);
        
        } else if (analysis && analysis.intent === 'update_balance') {
            // Case 3: Update Account Balance
            const updatedAccount = await updateAccountBalance(analysis.account);
            return ctx.reply(`✅ موجودی ثبت/به‌روز شد:\n${updatedAccount.name}: ${formatCurrency(updatedAccount.balance)} تومان`);
        
        } else if (analysis && analysis.intent === 'get_balance') {
            // Case 4: Get Account Balance
            const balanceMessage = await getAccountBalances(analysis.account);
            return ctx.reply(balanceMessage);

        } else if (analysis === null) {
            // Case 5: A major error occurred (network, API key, etc.)
            return ctx.reply('خطایی در ارتباط با هوش مصنوعی رخ داد. لطفاً بعداً تلاش کنید.');
        
        } else {
            // Case 6: analysis is {intent: "unrecognized"} (Gemini didn't understand the text)
            return ctx.reply('متوجه پیام شما نشدم. لطفاً دوباره تلاش کنید (مثلاً: "هزینه 10000 تست" یا "موجودی‌هام چقدره؟")');
        }

    } catch (error) {
        // Case 7: Catch any other unexpected errors in the main logic
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


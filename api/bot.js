// /api/bot.js - Serverless Function for Telegram Bot Webhook with Gemini AI
// FINAL VERSION: "Full AI" Analyst Mode

import { Telegraf } from 'telegraf';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, Timestamp, doc, setDoc, getDoc, collection, getDocs, query, where, orderBy, addDoc } from 'firebase-admin/firestore';
import { GoogleGenerativeAI } from '@google/generative-ai';

// --- CONFIGURATION ---
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const FIREBASE_USER_ID = process.env.FIREBASE_USER_ID;

const VALID_CATEGORIES = {
    income: ['فلش', 'فیلترشکن', 'اینستاگرام', 'اپل آیدی', 'همکار', 'سایر'],
    expense: ['خوراک', 'پوشاک', 'قهوه', 'قسط', 'اینترنت', 'سایر']
};

let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_CONFIG);
} catch (e) {
  console.error('Error parsing FIREBASE_ADMIN_CONFIG:', e.message);
}

// --- INITIALIZE SERVICES ---
if (!getApps().length) {
  try {
    initializeApp({ credential: cert(serviceAccount) });
  } catch (e) {
     console.error('Firebase Admin initialization error:', e.message);
  }
}

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
    return next();
  }
  console.warn(`Unauthorized access attempt by user ID: ${userId}`);
  return ctx.reply('شما مجاز به استفاده از این ربات نیستید.');
});

// --- HELPER FUNCTIONS ---
const formatCurrency = (num) => new Intl.NumberFormat('fa-IR').format(num);
const formatDate = (timestamp) => {
    return timestamp.toDate().toLocaleDateString('fa-IR', {
        timeZone: 'Asia/Tehran',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    });
};

// --- GEMINI AI LOGIC (PARSER) ---
// This prompt now only identifies "WRITE" actions or "READ" (ask) actions.
const GEMINI_PARSER_PROMPT = `
شما یک ربات تحلیلگر متن مالی به زبان فارسی هستید.
وظیفه شما فقط و فقط خروجی دادن JSON است.
متن ورودی کاربر را بخوانید و آن را به یکی از 5 ساختار JSON زیر تبدیل کنید.

لیست دسته‌بندی‌های مجاز برای تراکنش‌ها:
- هزینه (expense): ${JSON.stringify(VALID_CATEGORIES.expense)}
- درآمد (income): ${JSON.stringify(VALID_CATEGORIES.income)}

1.  **ثبت تراکنش (Write)**:
    {"intent": "add_transaction", "transaction": { "type": "expense" | "income", "amount": [number], "description": "[string]", "category": "[string]" }}
    -   **مهم:** اگر جمله فعل نداشت (مثل "خریدم")، آن را "expense" در نظر بگیر.
    مثال: "خرید تیشرت 5 میلیون" -> {"intent":"add_transaction", "transaction": {"type":"expense", "amount": 5000000, "description":"خرید تیشرت", "category": "پوشاک"}}
    مثال: "بسته اینترنت 92 تومن" -> {"intent":"add_transaction", "transaction": {"type":"expense", "amount": 92000, "description":"بسته اینترنت", "category": "اینترنت"}}

2.  **ثبت موجودی حساب (Write)**:
    {"intent": "update_balance", "account": { "name": "[string]", "balance": [number] }}
    مثال: "موجودی بانک ملی من ۵ میلیون است" -> {"intent":"update_balance", "account": {"name": "بانک ملی", "balance": 5000000}}

3.  **تنظیم یادآوری سفارشی (Write)**:
    {"intent": "set_reminder", "reminder": { "time": "[string] (HH:MM به وقت تهران)", "message": "[string]" }}
    -   **مهم:** فقط زمان‌های دقیق (مثل "ساعت ۳ بعد از ظهر" یا "ساعت ۲۱:۰۰") را بپذیر.
    مثال: "یادم بنداز ساعت 9 شب قسط رو بدم" -> {"intent":"set_reminder", "reminder": {"time": "21:00", "message": "قسط رو بدم"}}

4.  **پرسیدن سوال (Read/Analyze)**:
    {"intent": "ask_question", "question": "[string] (عین سوال کاربر)"}
    -   **مهم:** هر سوالی که در مورد داده‌ها پرسیده می‌شود (گزارش، لیست، تحلیل، موجودی) باید به این قصد تبدیل شود.
    مثال: "امروز چقدر خرج کردم؟" -> {"intent":"ask_question", "question": "امروز چقدر خرج کردم؟"}
    مثال: "امروز چی خریدم؟" -> {"intent":"ask_question", "question": "امروز چی خریدم؟"}
    مثال: "وضعیت مالی من چطوره؟" -> {"intent":"ask_question", "question": "وضعیت مالی من چطوره؟"}
    مثال: "موجودی‌هام چقدره؟" -> {"intent":"ask_question", "question": "موجودی‌هام چقدره؟"}

5.  **نامفهوم**:
    {"intent": "unrecognized"}
    مثال: "سلام خوبی؟" -> {"intent":"unrecognized"}
    مثال: "۵ دقیقه دیگه یادم بنداز" -> {"intent":"unrecognized"}

**مهم: پاسخ شما باید *فقط* و *همیشه* یکی از این ساختارها باشد.**
`;

async function getGeminiAnalysis(text) {
  if (!geminiModel) throw new Error("Gemini Model is not initialized.");
  
  let jsonText = "";
  try {
    const result = await geminiModel.generateContent({
        contents: [{ role: "user", parts: [{ text: text }] }],
        systemInstruction: {
            parts: [{ text: GEMINI_PARSER_PROMPT }]
        },
        generationConfig: { maxOutputTokens: 1024 },
    });
    
    const response = await result.response;

    if (response.promptFeedback && response.promptFeedback.blockReason) {
        console.warn(`Gemini blocked the prompt. Reason: ${response.promptFeedback.blockReason}`);
        return { intent: "unrecognized" };
    }
    if (!response.candidates || response.candidates[0].finishReason !== 'STOP') {
        console.warn(`Gemini did not finish. Reason: ${response.candidates[0].finishReason}`);
        return { intent: "unrecognized" };
    }

    jsonText = response.text();
    if (!jsonText) {
        console.warn("Gemini returned an empty string.");
        return { intent: "unrecognized" };
    }
    
    if (jsonText.includes("```json")) {
      jsonText = jsonText.split("```json")[1].split("```")[0];
    }
    else if (jsonText.startsWith("```")) {
      jsonText = jsonText.substring(3, jsonText.length - 3);
    }

    return JSON.parse(jsonText.trim());

  } catch (error) {
    console.error("Error in getGeminiAnalysis (network or parse):", error);
    if (error instanceof SyntaxError) {
        console.warn("Gemini returned non-JSON text:", jsonText);
        return { intent: "unrecognized" };
    }
    return null; // Major error
  }
}

// --- DATABASE "WRITE" LOGIC ---

async function addTransaction(transactionData) {
  const newTransaction = {
      type: transactionData.type,
      amount: transactionData.amount,
      description: transactionData.description,
      category: transactionData.category || 'سایر',
      date: new Date().toISOString().split('T')[0],
      time: new Date().toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tehran' }),
      createdAt: Timestamp.now(),
  };

  await db.collection('users').doc(FIREBASE_USER_ID).collection('transactions').add(newTransaction);
  return newTransaction;
}

async function updateAccountBalance(accountData) {
    const docRef = doc(db, 'users', FIREBASE_USER_ID, 'accounts', accountData.name);
    await setDoc(docRef, { 
        name: accountData.name,
        balance: accountData.balance,
        updatedAt: Timestamp.now()
    }, { merge: true });
    return accountData;
}

async function setReminder(reminderData) {
    const { time, message } = reminderData;
    const [hours, minutes] = time.split(':').map(Number);
    
    const nowInTehran = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tehran' }));
    const reminderTime = new Date(nowInTehran);
    reminderTime.setHours(hours, minutes, 0, 0);

    if (reminderTime < nowInTehran) {
        reminderTime.setDate(reminderTime.getDate() + 1);
    }

    await addDoc(collection(db, 'users', FIREBASE_USER_ID, 'reminders'), {
        message: message,
        runAt: Timestamp.fromDate(reminderTime),
        isSent: false
    });
    
    return `✅ یادآوری تنظیم شد:\n"${message}"\nدر ساعت ${time}`;
}

// --- "READ & ANALYZE" LOGIC ---

// This is the new "Full AI" function
async function handleAskQuestion(question) {
    
    // 1. Fetch ALL relevant data from Firebase
    let contextData = "";
    
    try {
        // Fetch Transactions (last 30 days)
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        const transQuery = query(
            collection(db, 'users', FIREBASE_USER_ID, 'transactions'),
            where('createdAt', '>=', Timestamp.fromDate(thirtyDaysAgo)),
            orderBy('createdAt', 'desc')
        );
        const transSnapshot = await getDocs(transQuery);
        if (!transSnapshot.empty) {
            contextData += "--- تراکنش‌های ۳۰ روز گذشته ---\n";
            transSnapshot.forEach(doc => {
                const t = doc.data();
                contextData += `- ${formatDate(t.createdAt)}: ${t.type === 'expense' ? 'هزینه' : 'درآمد'}، ${formatCurrency(t.amount)} تومان، ${t.description} (دسته: ${t.category})\n`;
            });
        }

        // Fetch Accounts
        const accSnapshot = await getDocs(collection(db, 'users', FIREBASE_USER_ID, 'accounts'));
        if (!accSnapshot.empty) {
            contextData += "\n--- موجودی حساب‌ها ---\n";
            accSnapshot.forEach(doc => {
                const a = doc.data();
                contextData += `- ${a.name}: ${formatCurrency(a.balance)} تومان\n`;
            });
        }
        
        // Fetch Installments
        const instSnapshot = await getDocs(collection(db, 'users', FIREBASE_USER_ID, 'installments'));
         if (!instSnapshot.empty) {
            contextData += "\n--- لیست اقساط ماهانه ---\n";
            instSnapshot.forEach(doc => {
                const i = doc.data();
                contextData += `- ${i.name}: ${formatCurrency(i.amount)} تومان (هر ماه روز ${i.day}م)\n`;
            });
        }
        
        if (contextData === "") {
            contextData = "هیچ داده‌ای (تراکنش، حساب یا قسط) هنوز ثبت نشده است.";
        }

    } catch (error) {
        console.error("Error fetching data for analysis:", error);
        return "خطا در خواندن اطلاعات از پایگاه‌داده. (آیا ایندکس‌ها ساخته شده‌اند؟)";
    }

    // 2. Define the Analyst Prompt
    const ANALYST_PROMPT = `
    شما یک حسابدار ارشد و مشاور مالی شخصی بسیار دقیق و خوش‌برخورد به زبان فارسی هستید.
    من "داده‌های خام" کاربر و "سوال" او را به شما می‌دهم.
    وظیفه شما این است که با استفاده از "داده‌های خام"، یک پاسخ کامل و تحلیلی به "سوال" کاربر بدهید.

    **مهم:**
    -   **دقیق باشید:** فقط بر اساس داده‌های ارائه‌شده پاسخ دهید.
    -   **محاسبه کنید:** اگر لازم است، اعداد را جمع بزنید.
    -   **خوش‌برخورد باشید:** پاسخ شما باید به زبان فارسی روان، دوستانه و حرفه‌ای باشد.
    -   **کامل پاسخ دهید:** اگر کاربر "لیست" خواست، لیست بدهید. اگر "تحلیل" خواست، تحلیل ارائه دهید.

    ---
    **داده‌های خام کاربر:**
    ${contextData}
    ---
    `;

    // 3. Call Gemini with context and question
    try {
        const result = await geminiModel.generateContent([
            ANALYST_PROMPT, // The system prompt (who you are)
            `سوال کاربر: "${question}"` // The user's question
        ]);
        const response = await result.response;
        return response.text();
    } catch (error) {
        console.error("Error in getFinancialAnalysis:", error);
        return "خطا در هنگام تحلیل داده‌ها توسط هوش مصنوعی.";
    }
}


// --- BOT HANDLERS ---

bot.start((ctx) => ctx.reply('سلام! من حسابدار هوشمند شما هستم.\nمی‌توانید بنویسید: "امروز ۵۰ تومن قهوه خریدم"\nیا بپرسید: "این ماه چقدر خرج کردم؟"'));

bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    await ctx.replyWithChatAction('typing');

    try {
        const analysis = await getGeminiAnalysis(text);

        if (analysis && analysis.intent === 'add_transaction') {
            // --- WRITE ACTION ---
            const newTransaction = await addTransaction(analysis.transaction);
            const typeText = newTransaction.type === 'income' ? 'درآمد' : 'هزینه';
            return ctx.reply(`✅ ثبت شد:\n${typeText} به مبلغ ${formatCurrency(newTransaction.amount)} تومان\n(شرح: ${newTransaction.description} | دسته‌بندی: ${newTransaction.category})`);
        
        } else if (analysis && analysis.intent === 'update_balance') {
            // --- WRITE ACTION ---
            const updatedAccount = await updateAccountBalance(analysis.account);
            return ctx.reply(`✅ موجودی ثبت/به‌روز شد:\n${updatedAccount.name}: ${formatCurrency(updatedAccount.balance)} تومان`);
        
        } else if (analysis && analysis.intent === 'set_reminder') {
            // --- WRITE ACTION ---
            const reminderMessage = await setReminder(analysis.reminder);
            return ctx.reply(reminderMessage);

        } else if (analysis && analysis.intent === 'ask_question') {
            // --- READ & ANALYZE ACTION ---
            await ctx.reply('در حال بررسی داده‌ها و مشورت با هوش مصنوعی... لطفاً چند لحظه صبر کنید.');
            const analysisMessage = await handleAskQuestion(analysis.question);
            return ctx.reply(analysisMessage);
            
        } else if (analysis === null) {
            // --- ERROR CASE ---
            return ctx.reply('خطایی در ارتباط با هوش مصنوعی رخ داد. لطفاً بعداً تلاش کنید.');
        
        } else { // analysis.intent === "unrecognized"
            // --- UNRECOGNIZED CASE ---
            return ctx.reply('متوجه پیام شما نشدم. لطفاً دوباره تلاش کنید (مثلاً: "هزینه 10000 تست" یا "وضعیت مالی من چطوره؟")');
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

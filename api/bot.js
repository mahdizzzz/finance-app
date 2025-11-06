// /api/bot.js - Serverless Function for Telegram Bot Webhook with Gemini AI

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
    expense: ['خوراک', 'پوشاک', 'قهوه', 'قسط', 'سایر']
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

const getDateRange = (period) => {
    const now = new Date();
    let start, end;
    
    if (period === 'today') {
        start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        end = new Date(start);
        end.setDate(start.getDate() + 1);
    } else if (period === 'month') {
        start = new Date(now.getFullYear(), now.getMonth(), 1);
        end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    } else if (period === 'week') {
        start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay()); // Start of week (Sunday)
        end = new Date(start);
        end.setDate(start.getDate() + 7);
    } else { // 'all_time' or default
        return null; // No date filter
    }
    
    return {
        start: Timestamp.fromDate(start),
        end: Timestamp.fromDate(end)
    };
};

// --- GEMINI AI LOGIC (PARSER) ---
// --- FIX: Simplified reminder prompt to be more reliable ---
const GEMINI_PARSER_PROMPT = `
شما یک ربات تحلیلگر متن مالی به زبان فارسی هستید.
وظیفه شما فقط و فقط خروجی دادن JSON است.
متن ورودی کاربر را بخوانید و آن را به یکی از 7 ساختار JSON زیر تبدیل کنید.

لیست دسته‌بندی‌های مجاز برای تراکنش‌ها:
- هزینه (expense): ${JSON.stringify(VALID_CATEGORIES.expense)}
- درآمد (income): ${JSON.stringify(VALID_CATEGORIES.income)}

1.  **ثبت تراکنش**:
    {"intent": "add_transaction", "transaction": { "type": "expense" | "income", "amount": [number], "description": "[string]", "category": "[string]" }}
    مثال: "خرید تیشرت 5 میلیون" -> {"intent":"add_transaction", "transaction": {"type":"expense", "amount": 5000000, "description":"خرید تیشرت", "category": "پوشاک"}}

2.  **درخواست گزارش (جمع کل)**:
    {"intent": "get_report", "report": { "type": "expense" | "income" | "all", "period": "today" | "month" | "all_time" }}
    مثال: "امروز چقدر خرج کردم؟" -> {"intent":"get_report", "report": {"type":"expense", "period":"today"}}

3.  **درخواست لیست تراکنش‌ها**:
    {"intent": "get_transaction_list", "report": { "type": "expense" | "income" | "all", "period": "today" | "month" }}
    مثال: "امروز چی خریدم؟" -> {"intent":"get_transaction_list", "report": {"type":"expense", "period":"today"}}

4.  **ثبت موجودی حساب**:
    {"intent": "update_balance", "account": { "name": "[string]", "balance": [number] }}
    مثال: "موجودی بانک ملی من ۵ میلیون است" -> {"intent":"update_balance", "account": {"name": "بانک ملی", "balance": 5000000}}

5.  **درخواست موجودی حساب**:
    {"intent": "get_balance", "account": { "name": "[string]" }}
    مثال: "موجودی‌هام چقدره؟" -> {"intent":"get_balance", "account": {"name": "all"}}

6.  **درخواست تحلیل هوشمند**:
    {"intent": "get_analysis", "period": "month" | "week" | "today" }
    مثال: "این ماه چطور بودم؟" -> {"intent":"get_analysis", "period":"month"}

7.  **تنظیم یادآوری سفارشی (ساده شده)**:
    {"intent": "set_reminder", "reminder": { "time": "[string] (HH:MM به وقت تهران)", "message": "[string]" }}
    -   شما باید عبارت زمانی کاربر را به فرمت دقیق HH:MM (۲۴ ساعته) تبدیل کنید.
    -   **مهم:** این ربات فقط زمان‌های دقیق (مثل "ساعت ۳ بعد از ظهر" یا "ساعت ۲۱:۰۰") را می‌فهمد.
    -   زمان‌های نسبی (مثل "۵ دقیقه دیگه" یا "۱ ساعت بعد") را به عنوان "unrecognized" در نظر بگیر.
    مثال: "ساعت ۳ بعد از ظهر یادم بنداز..." -> {"intent":"set_reminder", "reminder": {"time": "15:00", "message": "..."}}
    مثال: "یادم بنداز ساعت 9 شب قسط رو بدم" -> {"intent":"set_reminder", "reminder": {"time": "21:00", "message": "قسط رو بدم"}}
    مثال: "۵ دقیقه دیگه یادم بنداز" -> {"intent":"unrecognized"}

8.  **نامفهوم**:
    {"intent": "unrecognized"}
    مثال: "سلام خوبی؟" -> {"intent":"unrecognized"}

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
        generationConfig: { maxOutputTokens: 800, responseMimeType: "application/json" },
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
      time: new Date().toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tehran' }),
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
        dateRange = getDateRange('today');
        queryRef = queryRef.where('createdAt', '>=', dateRange.start).where('createdAt', '<', dateRange.end);
        periodText = "امروز";
    } else if (period === 'month') {
        dateRange = getDateRange('month');
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

async function getTransactionList(reportRequest) {
    let { type, period } = reportRequest;
    let queryRef = db.collection('users').doc(FIREBASE_USER_ID).collection('transactions');
    
    let dateRange;
    let periodText = "";
    if (period === 'today') {
        dateRange = getDateRange('today');
        queryRef = queryRef.where('createdAt', '>=', dateRange.start).where('createdAt', '<', dateRange.end);
        periodText = "امروز";
    } else if (period === 'month') {
        dateRange = getDateRange('month');
        queryRef = queryRef.where('createdAt', '>=', dateRange.start).where('createdAt', '<=', dateRange.end);
        periodText = "این ماه";
    }
    
    if (type === 'expense') {
        queryRef = queryRef.where('type', '==', 'expense');
    } else if (type === 'income') {
        queryRef = queryRef.where('type', '==', 'income');
    }

    queryRef = queryRef.orderBy('createdAt', 'desc');

    const snapshot = await queryRef.get();

    if (snapshot.empty) {
        return `هیچ تراکنشی برای ${periodText} یافت نشد.`;
    }

    let message = `لیست تراکنش‌های شما (${periodText}):\n\n`;
    snapshot.forEach(doc => {
        const t = doc.data();
        const sign = t.type === 'expense' ? '-' : '+';
        message += `• ${t.description} (${t.category}): ${sign}${formatCurrency(t.amount)} تومان\n`;
    });

    return message;
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

async function setReminder(reminderData) {
    const { time, message } = reminderData;
    const [hours, minutes] = time.split(':').map(Number);
    
    const nowInTehran = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tehran' }));
    
    const reminderTime = new Date(nowInTehran);
    reminderTime.setHours(hours, minutes, 0, 0);

    // If the calculated time is already in the past, set it for tomorrow
    if (reminderTime < nowInTehran) {
        reminderTime.setDate(reminderTime.getDate() + 1);
    }

    const docRef = await addDoc(collection(db, 'users', FIREBASE_USER_ID, 'reminders'), {
        message: message,
        runAt: Timestamp.fromDate(reminderTime),
        isSent: false
    });
    
    return `✅ یادآوری تنظیم شد:\n"${message}"\nدر ساعت ${time}`;
}

async function getFinancialAnalysis(period) {
    let dateRange;
    let periodText = "";
    if (period === 'week') {
        const today = new Date();
        const weekAgo = new Date(today);
        weekAgo.setDate(today.getDate() - 7);
        dateRange = { start: Timestamp.fromDate(weekAgo), end: Timestamp.now() };
        periodText = "۷ روز گذشته";
    } else if (period === 'today') {
        dateRange = getDateRange('today');
        periodText = "امروز";
    } else { // Default to month
        dateRange = getDateRange('month');
        periodText = "ماه جاری";
    }

    let queryRef = db.collection('users').doc(FIREBASE_USER_ID).collection('transactions')
                     .where('createdAt', '>=', dateRange.start)
                     .where('createdAt', '<=', dateRange.end)
                     .orderBy('createdAt', 'desc');

    const snapshot = await queryRef.get();
    if (snapshot.empty) {
        return `هیچ تراکنشی در ${periodText} ثبت نشده است تا تحلیلی ارائه دهم.`;
    }

    let transactionsList = [];
    let totalIncome = 0;
    let totalExpense = 0;
    snapshot.forEach(doc => {
        const t = doc.data();
        transactionsList.push(`- ${t.type === 'expense' ? 'هزینه' : 'درآمد'}: ${t.amount} تومان، شرح: ${t.description}، دسته‌بندی: ${t.category}`);
        if (t.type === 'income') totalIncome += t.amount;
        if (t.type === 'expense') totalExpense += t.amount;
    });
    
    const summary = `
    - مجموع درآمد: ${formatCurrency(totalIncome)} تومان
    - مجموع هزینه: ${formatCurrency(totalExpense)} تومان
    - تراز مالی: ${formatCurrency(totalIncome - totalExpense)} تومان
    `;
    
    const dataForGemini = `
    خلاصه آمار:
    ${summary}
    
    لیست تراکنش‌ها:
    ${transactionsList.join('\n')}
    `;

    const ANALYST_PROMPT = `
    شما یک حسابدار ارشد و مشاور مالی شخصی بسیار دقیق و خوش‌برخورد به زبان فارسی هستید.
    من داده‌های مالی کاربر در ${periodText} را به شما می‌دهم.
    وظیفه شما این است که یک تحلیل کوتاه (حداکثر در دو پاراگراف) ارائه دهید.

    در تحلیل خود به این موارد اشاره کنید:
    1.  وضعیت کلی مالی (تراز مثبت است یا منفی؟).
    2.  بیشترین هزینه‌ها در کدام دسته‌بندی‌ها بوده است؟ (این مهم‌ترین بخش است).
    3.  اگر نکته قابل توجهی (مثل خرج تکراری یا درآمد قابل توجه) می‌بینید، به آن اشاره کنید.
    4.  یک توصیه کوتاه برای بهبود وضعیت مالی ارائه دهید.

    فقط و فقط متن تحلیل را بنویسید. از JSON یا هرچیز دیگری استفاده نکنید.
    `;

    try {
        const result = await geminiModel.generateContent([ANALYST_PROMPT, `داده‌های کاربر:\n${dataForGemini}`]);
        const response = await result.response;
        return response.text();
    } catch (error) {
        console.error("Error in getFinancialAnalysis:", error);
        return "خطا در هنگام تحلیل داده‌ها توسط هوش مصنوعی.";
    }
}


// --- BOT HANDLERS ---

bot.start((ctx) => ctx.reply('سلام! من حسابدار هوشمند شما هستم.\nمی‌توانید بنویسید: "امروز ۵۰ تومن قهوه خریدم"\nیا بپرسید: "این ماه چقدر خرج کردم؟"\nیا بپرسید: "وضعیت مالی من چطوره؟"'));

bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    await ctx.replyWithChatAction('typing');

    try {
        const analysis = await getGeminiAnalysis(text);

        // --- DEBUG LINE ADDED ---
        // This will send the raw analysis object back to you.
        await ctx.reply(`--- DEBUG INFO ---\n${JSON.stringify(analysis, null, 2)}`);
        // --- END DEBUG ---

        if (analysis && analysis.intent === 'add_transaction') {
            const newTransaction = await addTransaction(analysis.transaction);
            const typeText = newTransaction.type === 'income' ? 'درآمد' : 'هزینه';
            return ctx.reply(`✅ ثبت شد:\n${typeText} به مبلغ ${formatCurrency(newTransaction.amount)} تومان\n(شرح: ${newTransaction.description} | دسته‌بندی: ${newTransaction.category})`);
        
        } else if (analysis && analysis.intent === 'get_report') {
            const reportMessage = await getReport(analysis.report);
            return ctx.reply(reportMessage);
        
        } else if (analysis && analysis.intent === 'get_transaction_list') {
            const listMessage = await getTransactionList(analysis.report);
            return ctx.reply(listMessage);

        } else if (analysis && analysis.intent === 'update_balance') {
            const updatedAccount = await updateAccountBalance(analysis.account);
            return ctx.reply(`✅ موجودی ثبت/به‌روز شد:\n${updatedAccount.name}: ${formatCurrency(updatedAccount.balance)} تومان`);
        
        } else if (analysis && analysis.intent === 'get_balance') {
            const balanceMessage = await getAccountBalances(analysis.account);
            return ctx.reply(balanceMessage);

        } else if (analysis && analysis.intent === 'get_analysis') {
            await ctx.reply('در حال تحلیل داده‌ها... لطفاً چند لحظه صبر کنید.');
            const analysisMessage = await getFinancialAnalysis(analysis.period);
            return ctx.reply(analysisMessage);
            
        } else if (analysis && analysis.intent === 'set_reminder') {
            const reminderMessage = await setReminder(analysis.reminder);
            return ctx.reply(reminderMessage);

        } else if (analysis === null) {
            return ctx.reply('خطایی در ارتباط با هوش مصنوعی رخ داد. لطفاً بعداً تلاش کنید.');
        
        } else { // analysis.intent === "unrecognized"
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

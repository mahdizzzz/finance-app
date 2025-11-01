// /api/cron.js - Vercel Cron Job for Reminders (Upgraded with Budgeting)

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, Timestamp, collection, getDocs, query, where } from 'firebase-admin/firestore';
import { Telegraf } from 'telegraf';

// --- CONFIGURATION ---
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
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

const db = getFirestore();
const bot = new Telegraf(BOT_TOKEN);

// --- HELPER FUNCTIONS ---
const getPersianDay = () => {
    const today = new Date();
    const persianDate = new Intl.DateTimeFormat('fa-IR-u-nu-latn', {
        day: 'numeric',
        timeZone: 'Asia/Tehran',
    }).format(today);
    return parseInt(persianDate, 10);
};

const getMonthYearString = () => {
    const today = new Date();
    // Get Persian year and month, e.g., "1403/08"
    return new Intl.DateTimeFormat('fa-IR-u-nu-latn', {
        year: 'numeric',
        month: '2-digit',
        timeZone: 'Asia/Tehran',
    }).format(today).slice(0, 7);
};

// --- CRON JOB LOGIC ---

// 1. Check for due installments
async function checkInstallments(todayDayNumber) {
    const installmentsRef = db.collection('users').doc(FIREBASE_USER_ID).collection('installments');
    const snapshot = await installmentsRef.get();
    let installmentMessages = [];

    if (snapshot.empty) {
        console.log("No installments found.");
        return installmentMessages;
    }

    snapshot.forEach(doc => {
        const installment = doc.data();
        const daysRemaining = installment.day - todayDayNumber;

        if (daysRemaining >= 0 && daysRemaining <= 3) { // 3 days warning
            let reminderMessage = "";
            if (daysRemaining === 0) {
                reminderMessage = `❗️ امروز (${installment.day}م) موعد قسط "${installment.name}" به مبلغ ${installment.amount.toLocaleString('fa-IR')} تومان است.`;
            } else {
                reminderMessage = `🔔 ${daysRemaining} روز دیگر (${installment.day}م) موعد قسط "${installment.name}" به مبلغ ${installment.amount.toLocaleString('fa-IR')} تومان است.`;
            }
            installmentMessages.push(reminderMessage);
        }
    });
    return installmentMessages;
}

// 2. Check budgets
async function checkBudgets() {
    const budgetsRef = db.collection('users').doc(FIREBASE_USER_ID).collection('budgets');
    const budgetSnapshot = await budgetsRef.get();
    let budgetMessages = [];

    if (budgetSnapshot.empty) {
        console.log("No budgets set.");
        return budgetMessages;
    }

    // Get all expenses for the current Persian month
    const currentMonth = getMonthYearString(); // e.g., "1403/08"
    const transactionsRef = db.collection('users').doc(FIREBASE_USER_ID).collection('transactions');
    const qExpenses = query(
        transactionsRef,
        where('type', '==', 'expense'),
        where('date', '>=', `${currentMonth}/01`),
        where('date', '<=', `${currentMonth}/31`) // Simple string comparison works
    );
    
    const expenseSnapshot = await qExpenses.get();
    
    // Calculate current spending per category
    const monthlyExpenses = {};
    expenseSnapshot.forEach(doc => {
        const t = doc.data();
        monthlyExpenses[t.category] = (monthlyExpenses[t.category] || 0) + t.amount;
    });

    console.log("Current monthly expenses:", monthlyExpenses);

    budgetSnapshot.forEach(doc => {
        const budget = doc.data();
        const spent = monthlyExpenses[budget.category] || 0;
        const percent = (spent / budget.amount) * 100;

        if (percent >= 90) { // Warning at 90%
            let budgetMessage = `⚠️ هشدار بودجه: شما ${percent.toFixed(0)}٪ از بودجه ماهانه "${budget.category}" (سقف: ${budget.amount.toLocaleString('fa-IR')}) را مصرف کرده‌اید.`;
            budgetMessages.push(budgetMessage);
        }
    });
    return budgetMessages;
}


// --- VERCEL HANDLER ---
// This function will be triggered by the Vercel Cron schedule
export default async (req, res) => {
    try {
        const todayDayNumber = getPersianDay();
        let finalMessage = `--- گزارش خودکار حسابدار (امروز: ${new Date().toLocaleDateString('fa-IR', {timeZone: 'Asia/Tehran'})}) ---\n`;
        let messagesFound = false;

        // Check 1: Installments
        const installmentMessages = await checkInstallments(todayDayNumber);
        if (installmentMessages.length > 0) {
            messagesFound = true;
            finalMessage += "\n**یادآوری اقساط:**\n" + installmentMessages.join("\n") + "\n";
        }

        // Check 2: Budgets
        const budgetMessages = await checkBudgets();
        if (budgetMessages.length > 0) {
            messagesFound = true;
            finalMessage += "\n**هشدار بودجه:**\n" + budgetMessages.join("\n") + "\n";
        }
        
        // Check 3: Daily reminder (if no other messages)
        // We only send the generic reminder if there are no specific installment/budget warnings
        if (!messagesFound) {
            const dayOfWeek = new Date().toLocaleDateString('fa-IR-u-nu-latn', { weekday: 'long', timeZone: 'Asia/Tehran' });
            // Only send generic reminder on certain days, e.g., end of week
            if (dayOfWeek === 'پنج‌شنبه' || dayOfWeek === 'جمعه') {
                 finalMessage += "\nشب بخیر! یادت نره خرج و دخل امروزت رو در ربات ثبت کنی. (مثال: هزینه ۵۰۰۰۰ قهوه)";
                 messagesFound = true;
            } else {
                console.log("No reminders to send today.");
            }
        }

        // Send the final compiled message if there's anything to say
        if (messagesFound) {
            await bot.telegram.sendMessage(CHAT_ID, finalMessage);
            res.status(200).send('Cron job executed successfully, reminders sent.');
        } else {
            res.status(200).send('Cron job executed, no reminders needed today.');
        }

    } catch (e) {
        console.error('Error executing cron job:', e.message);
        res.status(500).send('Error');
    }
};


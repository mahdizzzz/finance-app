// /api/cron.js - Vercel Cron Job for Reminders (Upgraded with Budgeting + Custom Reminders)

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, Timestamp, collection, getDocs, query, where, deleteDoc } from 'firebase-admin/firestore';
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
if (!getApps().length) {
  try {
    initializeApp({ credential: cert(serviceAccount) });
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
    return new Intl.DateTimeFormat('fa-IR-u-nu-latn', {
        year: 'numeric',
        month: '2-digit',
        timeZone: 'Asia/Tehran',
    }).format(today).slice(0, 7);
};

// Function to check if it's time for the daily summary (e.g., once per day)
const isTimeForDailySummary = () => {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tehran' }));
    // Run this check only once per day, e.g., between 9:00 and 9:05 AM Tehran time
    return now.getHours() === 9 && now.getMinutes() < 5;
};

// --- CRON JOB LOGIC ---

// 1. Check for due installments (runs once daily)
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

// 2. Check budgets (runs once daily)
async function checkBudgets() {
    const budgetsRef = db.collection('users').doc(FIREBASE_USER_ID).collection('budgets');
    const budgetSnapshot = await budgetsRef.get();
    let budgetMessages = [];

    if (budgetSnapshot.empty) {
        console.log("No budgets set.");
        return budgetMessages;
    }

    const currentMonth = getMonthYearString();
    const transactionsRef = db.collection('users').doc(FIREBASE_USER_ID).collection('transactions');
    const qExpenses = query(
        transactionsRef,
        where('type', '==', 'expense'),
        where('date', '>=', `${currentMonth}/01`),
        where('date', '<=', `${currentMonth}/31`)
    );
    
    const expenseSnapshot = await qExpenses.get();
    
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

// 3. Check for Custom Reminders (runs every 5 minutes)
async function checkCustomReminders() {
    const remindersRef = db.collection('users').doc(FIREBASE_USER_ID).collection('reminders');
    const now = Timestamp.now();
    
    // Find reminders that are due (runAt <= now) and not sent
    const qReminders = query(
        remindersRef,
        where('isSent', '==', false),
        where('runAt', '<=', now)
    );

    const snapshot = await qReminders.get();
    let reminderMessages = [];

    if (snapshot.empty) {
        console.log("No custom reminders due.");
        return reminderMessages;
    }

    for (const doc of snapshot.docs) {
        const reminder = doc.data();
        console.log(`Sending custom reminder: ${reminder.message}`);
        
        // Add to message list
        reminderMessages.push(`⏰ یادآوری سفارشی: ${reminder.message}`);
        
        // Mark as sent so it doesn't send again
        // We delete it immediately for simplicity
        await deleteDoc(doc.ref); 
    }
    
    return reminderMessages;
}


// --- VERCEL HANDLER ---
// This function will be triggered by the Vercel Cron schedule (every 5 minutes)
export default async (req, res) => {
    try {
        let messagesToSend = [];
        
        // --- Task 1: Check Custom Reminders (Every 5 minutes) ---
        const customReminders = await checkCustomReminders();
        messagesToSend.push(...customReminders);

        // --- Task 2: Daily Summary (Installments + Budgets) ---
        // We run this only once per day to avoid spamming
        if (isTimeForDailySummary()) {
            console.log("Running daily summary tasks...");
            const todayDayNumber = getPersianDay();
            
            const installmentMessages = await checkInstallments(todayDayNumber);
            if (installmentMessages.length > 0) {
                messagesToSend.push("\n--- یادآوری اقساط ---\n" + installmentMessages.join("\n"));
            }

            const budgetMessages = await checkBudgets();
            if (budgetMessages.length > 0) {
                messagesToSend.push("\n--- هشدار بودجه ---\n" + budgetMessages.join("\n"));
            }
        }

        // Send the final compiled message if there's anything to send
        if (messagesToSend.length > 0) {
            const fullMessage = messagesToSend.join("\n\n");
            await bot.telegram.sendMessage(CHAT_ID, fullMessage);
            res.status(200).send('Cron job executed successfully, reminders sent.');
        } else {
            res.status(200).send('Cron job executed, no reminders needed.');
        }

    } catch (e) {
        console.error('Error executing cron job:', e.message);
        res.status(500).send('Error');
    }
};

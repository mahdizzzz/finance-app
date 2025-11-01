// /api/cron.js - Vercel Cron Job for Reminders

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
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

// --- HELPER FUNCTION ---
const getPersianDay = () => {
    // Get today's day number in Persian (Iran time)
    const today = new Date();
    const persianDate = new Intl.DateTimeFormat('fa-IR-u-nu-latn', {
        day: 'numeric',
        timeZone: 'Asia/Tehran',
    }).format(today);
    return parseInt(persianDate, 10);
};

// --- MAIN CRON JOB LOGIC ---
async function checkInstallmentsAndNotify() {
    if (!FIREBASE_USER_ID || !CHAT_ID) {
        console.error("Missing FIREBASE_USER_ID or CHAT_ID");
        return;
    }

    const todayDayNumber = getPersianDay();
    console.log(`Cron job running. Today's Persian day: ${todayDayNumber}`);

    const installmentsRef = db.collection('users').doc(FIREBASE_USER_ID).collection('installments');
    const snapshot = await installmentsRef.get();

    if (snapshot.empty) {
        console.log("No installments found for user.");
        return;
    }

    let messagesToSend = [];

    snapshot.forEach(doc => {
        const installment = doc.data();
        const daysRemaining = installment.day - todayDayNumber;

        if (daysRemaining >= 0 && daysRemaining <= 3) {
            // Found an installment due soon
            let reminderMessage = "";
            if (daysRemaining === 0) {
                reminderMessage = `❗️ یادآوری قسط: امروز (${installment.day}م) موعد پرداخت قسط "${installment.name}" به مبلغ ${installment.amount.toLocaleString('fa-IR')} تومان است.`;
            } else {
                reminderMessage = `🔔 یادآوری قسط: ${daysRemaining} روز دیگر (${installment.day}م) موعد پرداخت قسط "${installment.name}" به مبلغ ${installment.amount.toLocaleString('fa-IR')} تومان است.`;
            }
            messagesToSend.push(reminderMessage);
        }
    });

    if (messagesToSend.length > 0) {
        console.log(`Sending ${messagesToSend.length} reminders...`);
        // Send all messages to the user
        const fullMessage = "--- یادآوری اقساط ---\n\n" + messagesToSend.join("\n\n");
        await bot.telegram.sendMessage(CHAT_ID, fullMessage);
    } else {
        console.log("No installments due soon.");
    }
}

// --- VERCEL HANDLER ---
// This function will be triggered by the Vercel Cron schedule
export default async (req, res) => {
    try {
        await checkInstallmentsAndNotify();
        res.status(200).send('Cron job executed successfully.');
    } catch (e) {
        console.error('Error executing cron job:', e.message);
        res.status(500).send('Error');
    }
};

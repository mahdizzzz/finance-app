// /api/bot.js - Serverless Function for Telegram Bot Webhook

// Import necessary libraries
import { Telegraf } from 'telegraf';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// --- CONFIGURATION ---
// These will be read from Vercel's Environment Variables
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// Firebase Admin SDK Configuration
// We need to parse the JSON string from the environment variable
let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_CONFIG);
} catch (e) {
  console.error('Error parsing FIREBASE_ADMIN_CONFIG:', e.message);
}

// Initialize Firebase Admin (only if not already initialized)
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

// --- BOT LOGIC ---

// Helper function to parse the message
// Format: [نوع] [مبلغ] [شرح]
// Example: هزینه 50000 قهوه
const parseTransaction = (text) => {
    const parts = text.split(' ');
    if (parts.length < 2) return null;

    let type;
    const typeKeyword = parts[0].toLowerCase();
    if (typeKeyword === 'هزینه' || typeKeyword === 'خرج' || typeKeyword === 'e') {
        type = 'expense';
    } else if (typeKeyword === 'درآمد' || typeKeyword === 'سود' || typeKeyword === 'i') {
        type = 'income';
    } else {
        return null; // Invalid type
    }

    const amount = parseInt(parts[1], 10);
    if (isNaN(amount) || amount <= 0) return null; // Invalid amount

    const description = parts.length > 2 ? parts.slice(2).join(' ') : 'ثبت شده توسط ربات';
    const category = parts.length > 2 ? 'سایر' : (type === 'income' ? 'سایر' : 'سایر'); // Default category

    return { type, amount, description, category };
};

// Set up the bot command listeners
bot.start((ctx) => ctx.reply('سلام! این ربات مدیریت مالی شخصی شماست. برای ثبت تراکنش، پیامی مانند "هزینه 50000 قهوه" ارسال کنید.'));

bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    const userId = ctx.message.from.id.toString(); // Use Telegram User ID as the identifier
    
    // --- IMPORTANT SECURITY CHECK ---
    // Compare the sender's ID with your configured CHAT_ID to ensure only you can add data.
    if (userId !== process.env.TELEGRAM_CHAT_ID) {
        console.warn(`Unauthorized access attempt by user ID: ${userId}`);
        return ctx.reply('شما مجاز به استفاده از این ربات نیستید.');
    }

    const transaction = parseTransaction(text);

    if (!transaction) {
        return ctx.reply('فرمت پیام اشتباه است. لطفاً از این فرمت استفاده کنید: [نوع] [مبلغ] [شرح]\nمثال: هزینه 50000 قهوه');
    }

    try {
        // Prepare data for Firestore
        const newTransaction = {
            ...transaction,
            date: new Date().toISOString().split('T')[0], // Today's date
            time: new Date().toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' }),
            createdAt: new Date(), // Server timestamp
        };

        // Add to Firestore database under your user ID
        // NOTE: This assumes your Firestore security rules are set up to allow this,
        // or that the admin SDK bypasses them.
        // We'll use the Telegram User ID to find the correct user document
        // For simplicity, we'll find the user by their chat ID.
        // A better approach would be to link Firebase Auth UID with Telegram ID,
        // but for a personal bot, we can find the user via an assumed "telegramId" field.
        
        // This is a simplification: We assume the Firestore collection 'users'
        // has documents where the document ID IS the Firebase Auth UID.
        // We can't easily get the Firebase Auth UID from a Telegram ID without a lookup.
        
        // Let's change the logic: We'll add a "telegramUserId" field to your user doc in Firebase.
        // For now, let's assume your Firebase Auth UID is stored as an env var.
        
        const FIREBASE_USER_ID = process.env.FIREBASE_USER_ID;
        if (!FIREBASE_USER_ID) {
             return ctx.reply('خطای سرور: شناسه کاربر Firebase تنظیم نشده است.');
        }

        const docRef = await db.collection('users').doc(FIREBASE_USER_ID).collection('transactions').add(newTransaction);
        
        console.log(`Transaction added with ID: ${docRef.id} for user ${FIREBASE_USER_ID}`);
        
        const typeText = transaction.type === 'income' ? 'درآمد' : 'هزینه';
        return ctx.reply(`✅ ثبت شد:\n${typeText} به مبلغ ${transaction.amount} تومان (${transaction.description})`);

    } catch (error) {
        console.error('Error writing to Firestore:', error);
        return ctx.reply('خطایی در ثبت تراکنش در پایگاه‌داده رخ داد.');
    }
});

// --- VERCEL HANDLER ---
// This part connects the bot to Vercel's serverless environment
export default async (req, res) => {
    try {
        await bot.handleUpdate(req.body);
        res.status(200).send('OK');
    } catch (e) {
        console.error('Error handling update:', e);
        res.status(500).send('Error');
    }
};

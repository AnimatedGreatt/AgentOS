const admin = require('firebase-admin');
require('dotenv').config();

if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_PRIVATE_KEY || !process.env.FIREBASE_CLIENT_EMAIL) {
    throw new Error('Missing Firebase service account fields. Please check your service account JSON file.');
}

admin.initializeApp({
credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  }),    databaseURL: "https://agentos-ab3f9-default-rtdb.firebaseio.com"
});

const db = admin.database();

module.exports = db;
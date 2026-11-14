const admin = require('firebase-admin');
const serviceAccount = require('../../agentos-c3e04-firebase-adminsdk-fbsvc-ad86efd25e.json');

if (!serviceAccount.project_id || !serviceAccount.private_key || !serviceAccount.client_email) {
    throw new Error('Missing Firebase service account fields. Please check your service account JSON file.');
}

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://agentos-c3e04-default-rtdb.firebaseio.com/"
});

const db = admin.database();

module.exports = db;
const admin = require('firebase-admin');
const serviceAccount = require('../../agentos-ab3f9-firebase-adminsdk-fbsvc-98727ace1d.json');

if (!serviceAccount.project_id || !serviceAccount.private_key || !serviceAccount.client_email) {
    throw new Error('Missing Firebase service account fields. Please check your service account JSON file.');
}

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://agentos-ab3f9-default-rtdb.firebaseio.com"
});

const db = admin.database();

module.exports = db;
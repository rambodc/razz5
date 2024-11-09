// Firebase Cloud Function: runAI4.js
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { BigQuery } = require('@google-cloud/bigquery');

// Only initialize Firebase Admin if it hasn't been initialized
if (!admin.apps.length) {
    admin.initializeApp();
}

const bigquery = new BigQuery();

module.exports.runAI4 = functions.https.onRequest(async (req, res) => {
    // Set CORS headers for preflight requests
    const allowedOrigin = functions.config().cors.origin || '*';
    res.set('Access-Control-Allow-Origin', allowedOrigin);
    res.set('Access-Control-Allow-Methods', 'GET, POST');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === "OPTIONS") {
        // Handle preflight request
        res.status(204).send('');
        return;
    }

    if (req.method !== "POST") {
        return res.status(405).send("Method Not Allowed");
    }

    // Verify the Firebase ID Token from Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(403).send("Unauthorized: Missing or invalid Authorization header");
    }

    const idToken = authHeader.split("Bearer ")[1];

    try {
        // Verify the token using Firebase Admin
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        const uid = decodedToken.uid;
        console.log(`Token verified successfully for UID: ${uid}`);

        // Extract necessary parameters from the request body
        const { query, type } = req.body;

        if (!query || !type) {
            return res.status(400).send("Missing required parameters: query or type");
        }

        // Execute the BigQuery
        const options = {
            query: query,
            location: 'US',
        };

        const [job] = await bigquery.createQueryJob(options);
        console.log(`BigQuery job ${job.id} started.`);

        const [rows] = await job.getQueryResults();

        // Convert BigQuery timestamps to Firestore-compatible format
        const sanitizedRows = rows.map(row => {
            const sanitizedRow = {};
            for (const key in row) {
                if (row[key] && typeof row[key].value === 'function') {
                    sanitizedRow[key] = row[key].value();  // Convert to string or Date
                } else {
                    sanitizedRow[key] = row[key];
                }
            }
            return sanitizedRow;
        });

        // Respond with the query result
        return res.status(200).send({ status: "success", message: "BigQuery executed successfully", data: sanitizedRows });

    } catch (error) {
        console.error("Error executing function:", error);
        if (error.code === 'auth/argument-error') {
            return res.status(403).send({ status: "error", message: "Invalid or expired Firebase Auth Token." });
        }
        return res.status(500).send({ status: "error", message: error.message });
    }
});
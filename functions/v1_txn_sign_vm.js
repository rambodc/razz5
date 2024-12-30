// Firebase Cloud Function: v1_txn_sign_vm.js
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const axios = require('axios');

if (!admin.apps.length) {
    admin.initializeApp();
}

// General initialization and checks
async function initializeAndCheck(req, res) {
    // Set CORS headers for preflight requests
    const allowed_origin = functions.config().cors.origin || '*';
    res.set('Access-Control-Allow-Origin', allowed_origin);
    res.set('Access-Control-Allow-Methods', 'GET, POST');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === "OPTIONS") {
        res.status(204).send('');
        return { proceed: false };
    }

    if (req.method !== "POST") {
        res.status(405).send("Method Not Allowed");
        return { proceed: false };
    }

    // Extract parameters
    const { uid, interaction_id } = req.body;

    if (!uid || !interaction_id) {
        res.status(400).send("Missing required parameters: uid or interaction_id");
        return { proceed: false };
    }

    // Extract and verify Firebase Auth Token
    const idToken = req.headers.authorization?.split('Bearer ')[1];
    if (!idToken) {
        res.status(401).send("Unauthorized: Missing Firebase Auth Token");
        return { proceed: false };
    }

    let decodedToken;
    try {
        decodedToken = await admin.auth().verifyIdToken(idToken);
    } catch (error) {
        console.error(`Error verifying token: ${error.message}`);
        res.status(403).send("Unauthorized: Invalid Firebase Auth Token");
        return { proceed: false };
    }

    // Ensure the authenticated user's UID matches the request UID
    if (decodedToken.uid !== uid) {
        res.status(403).send("Unauthorized: UID mismatch");
        return { proceed: false };
    }

    try {
        // Fetch the interaction document
        const interactionRef = admin.firestore().collection('interactions').doc(interaction_id);
        const interactionDoc = await interactionRef.get();

        if (!interactionDoc.exists) {
            res.status(404).send("Interaction document not found");
            return { proceed: false };
        }

        const interactionData = interactionDoc.data();
        return { proceed: true, interactionData, interactionRef };
    } catch (error) {
        console.error(`Error during initialization and checks: ${error.message}`);
        res.status(500).send({ status: "error", message: error.message });
        return { proceed: false };
    }
}

module.exports.v1_txn_sign_vm = functions.https.onRequest(async (req, res) => {
    // Perform general initialization and checks
    const init_result = await initializeAndCheck(req, res);
    if (!init_result.proceed) {
        return;
    }

    const { interactionData, interactionRef } = init_result;

    // Extract transactions
    const { txn1, txn2 } = interactionData;
    const transactionsToProcess = [];

    if (txn1) {
        transactionsToProcess.push({ txnKey: 'txn1', txnData: txn1 });
    }

    if (txn2) {
        transactionsToProcess.push({ txnKey: 'txn2', txnData: txn2 });
    }

    if (transactionsToProcess.length === 0) {
        res.status(400).send({
            status: "error",
            message: "No valid transactions (txn1 or txn2) found in the document",
        });
        return;
    }

    for (const txn of transactionsToProcess) {
        try {
            console.log(`Processing ${txn.txnKey}...`);
            const result = await axios.post('http://34.122.67.187:8080/sign-transaction', {
                transaction: txn.txnData,
            });

            const statusField = `${txn.txnKey}_status`;
            const status = result.data.success ? 'success' : 'failed';

            // Update Firestore with the transaction status
            await interactionRef.update({
                [statusField]: status,
            });

            console.log(`Updated ${statusField} to ${status}`);
        } catch (error) {
            console.error(`Error processing ${txn.txnKey}:`, error.message);

            // Update the status as failed if an error occurs
            const statusField = `${txn.txnKey}_status`;
            await interactionRef.update({
                [statusField]: 'failed',
            });
        }
    }

    res.status(200).send({ status: "success", message: "Transactions processed" });
});

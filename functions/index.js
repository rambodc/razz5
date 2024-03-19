const functions = require('firebase-functions');
const admin = require('firebase-admin');
const cors = require('cors')({origin: true});

if (admin.apps.length === 0) { // Prevents initializing the app more than once
    admin.initializeApp(); }


    
exports.getExample = functions.https.onRequest((request, response) => {
    cors(request, response, () => {
        if (request.method === 'GET') {
            response.send('Hello, this is a GET request!');
        } else {
            response.status(405).send('Method Not Allowed');
        }
    });
});



exports.simplePostAPI = functions.https.onRequest((req, res) => {
    cors(req, res, async () => {
        if (req.method !== 'POST') {
            return res.status(405).send({ error: 'Method Not Allowed' });
        }

        // Verify Firebase ID Token
        const idToken = req.get('Authorization')?.split('Bearer ')[1];
        if (!idToken) {
            return res.status(403).send({ error: 'Unauthorized' });
        }

        try {
            // Verify the token with Firebase Admin SDK
            const decodedToken = await admin.auth().verifyIdToken(idToken);
            if (!decodedToken) {
                return res.status(403).send({ error: 'Unauthorized' });
            }

            // Token is verified, proceed with the POST request
            res.status(200).send({ 
                message: "Received data successfully",
                receivedData: req.body
            });
        } catch (error) {
            console.error('Error verifying token:', error);
            res.status(403).send({ error: 'Unauthorized' });
        }
    });
});


exports.createUserRecord = functions.https.onRequest((req, res) => {
    cors(req, res, async () => {
        if (req.method !== 'POST') {
            return res.status(405).send({error: 'Method Not Allowed'});
        }

        // Verify Firebase ID Token
        const idToken = req.get('Authorization')?.split('Bearer ')[1];
        if (!idToken) {
            return res.status(403).send({error: 'Unauthorized'});
        }

        try {
            const decodedToken = await admin.auth().verifyIdToken(idToken);
            const uid = decodedToken.uid; // Extracted UID from the verified token

            // Additional check to match the uid from the token with the one sent in the request
            const { firstName, lastName, uid: requestUid } = req.body;
            if (uid !== requestUid) {
                return res.status(403).send({error: 'UID mismatch'});
            }

            // Proceed to create or update the user document in Firestore
            const userRef = admin.firestore().collection('users').doc(uid);
            await userRef.set({
                firstName,
                lastName,
                uid
            });

            return res.status(200).send({
                message: "User record created successfully",
                userData: { firstName, lastName, uid }
            });

        } catch (error) {
            console.error('Error verifying Firebase ID token:', error);
            return res.status(403).send({error: 'Unauthorized'});
        }
    });
});
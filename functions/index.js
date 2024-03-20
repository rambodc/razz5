const functions = require('firebase-functions');
const admin = require('firebase-admin');
const cors = require('cors')({origin: true});

admin.initializeApp();


exports.helloWorld = functions.https.onRequest((req, res) => {
    cors(req, res, async () => {
        if (req.method !== 'GET') {
            return res.status(405).send({ error: 'Method Not Allowed' });
        }

        // Replace 'YOUR_API_KEY_HERE' with your actual API key
        const expectedApiKey = 'AIzaSyANmQttQ0QVtpYMQhkjHL06FH8GcQFMIW8';
        // In this example, the API key is expected as a query parameter 'apiKey'
        const providedApiKey = req.query.apiKey;

        if (providedApiKey !== expectedApiKey) {
            console.error('Invalid or missing API key');
            return res.status(401).send('Unauthorized: Invalid API key');
        }

        // If the API key is correct, send a "Hello, world" response
        res.send('Hello, world!');
    });
});



exports.testWriteToFirestore = functions.https.onRequest((req, res) => {
    cors(req, res, async () => {
        if (req.method !== 'POST') {
            return res.status(405).send({ error: 'Method Not Allowed' });
        }

        // No token verification, proceed to write a simple record to Firestore
        const docRef = admin.firestore().collection('testCollection').doc('helloRecord');

        docRef.set({ field: "World" })
            .then(() => {
                return res.status(200).send({
                    message: "Record created successfully",
                    data: { field: "World" }
                });
            })
            .catch((error) => {
                console.error('Error writing to Firestore:', error);
                return res.status(500).send({ error: 'Internal Server Error', details: error.message });
            });
    });
});
    

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


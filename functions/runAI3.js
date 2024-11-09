// Firebase Cloud Function: simplified_runAI3.js
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { VertexAI } = require('@google-cloud/vertexai');

// Only initialize Firebase Admin if it hasn't been initialized
if (!admin.apps.length) {
    admin.initializeApp();
}

module.exports.runAI3 = functions.https.onRequest(async (req, res) => {
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
        const { prompt, type } = req.body;

        if (!prompt || !type) {
            return res.status(400).send("Missing required parameters: prompt or type");
        }

        // Create a new document in functionCalls collection with prompt and type fields
        const functionCallRef = await admin.firestore().collection('functionCalls').add({
            prompt: prompt,
            type: type,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            uid: uid
        });

        const documentId = functionCallRef.id;

        // Initialize Vertex AI
        const vertexProject = functions.config().vertex.project;
        const vertexLocation = functions.config().vertex.location;
        const vertexAI = new VertexAI({ project: vertexProject, location: vertexLocation });

        // Call Vertex AI to get a response based on the prompt
        const generativeModel = vertexAI.preview.getGenerativeModel({
            model: 'gemini-1.5-flash-001',
            generationConfig: {
                maxOutputTokens: 8192,
                temperature: 1,
                topP: 0.95,
            },
            safetySettings: [
                {
                    category: 'HARM_CATEGORY_HATE_SPEECH',
                    threshold: 'BLOCK_MEDIUM_AND_ABOVE'
                },
                {
                    category: 'HARM_CATEGORY_DANGEROUS_CONTENT',
                    threshold: 'BLOCK_MEDIUM_AND_ABOVE'
                },
                {
                    category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
                    threshold: 'BLOCK_MEDIUM_AND_ABOVE'
                },
                {
                    category: 'HARM_CATEGORY_HARASSMENT',
                    threshold: 'BLOCK_MEDIUM_AND_ABOVE'
                }
            ],
        });

        // Generate content based on the prompt
        const request = {
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
        };

        console.log('Request to Vertex AI:', JSON.stringify(request, null, 2));

        const streamingResult = await generativeModel.generateContentStream(request);
        let responseText = '';
        for await (const item of streamingResult.stream) {
            responseText += JSON.stringify(item) + '\n';
        }
        const aggregatedResponse = await streamingResult.response;

        // Update the functionCall document with the response
        await functionCallRef.update({
            response: aggregatedResponse,
            completedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // Respond with success message
        return res.status(200).send({ status: "success", message: "Vertex AI response generated and document updated", documentId });

    } catch (error) {
        console.error("Error executing function:", error);
        if (error.code === 'auth/argument-error') {
            return res.status(403).send({ status: "error", message: "Invalid or expired Firebase Auth Token." });
        }
        return res.status(500).send({ status: "error", message: error.message });
    }
});

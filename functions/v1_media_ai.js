const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { VertexAI } = require('@google-cloud/vertexai');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Only initialize Firebase Admin if it hasn't been initialized
if (!admin.apps.length) {
    admin.initializeApp();
}

const vertex_project = functions.config().vertex.project;
const vertex_location = functions.config().vertex.location;
const key_filename = path.join(__dirname, 'service-account.json');

// Initialize VertexAI client with the service account key and environment variables
const vertex_ai = new VertexAI({ project: vertex_project, location: vertex_location, keyFilename: key_filename });

// General initialization and checks for all functions
async function initializeAndCheck(req, res) {
    // Set CORS headers for preflight requests
    const allowed_origin = functions.config().cors.origin || '*';
    res.set('Access-Control-Allow-Origin', allowed_origin);
    res.set('Access-Control-Allow-Methods', 'GET, POST');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === "OPTIONS") {
        // Handle preflight request
        res.status(204).send('');
        return { proceed: false };
    }

    if (req.method !== "POST") {
        res.status(405).send("Method Not Allowed");
        return { proceed: false };
    }

    // Extract necessary parameters from the request body
    const { uid, prompt, post_id } = req.body;

    if (!uid || !prompt || !post_id) {
        res.status(400).send("Missing required parameters: uid, prompt, or post_id");
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

    const actions_ref = admin.firestore().collection('actions').doc(uid);

    try {
        // General action check before proceeding
        const actions_doc = await actions_ref.get();
        if (!actions_doc.exists) {
            throw new Error('Actions document does not exist.');
        }

        const actions_data = actions_doc.data();
        const current_time = new Date();
        const reset_global_action_at = actions_data.general.reset_global_action_at;
        let total_actions_today = actions_data.general.total_actions_today;
        const daily_limit = actions_data.general.daily_limit;

        // Convert Firestore timestamp to JavaScript Date
        const reset_global_action_at_date = new Date(reset_global_action_at.seconds * 1000);

        // Check if 24 hours have passed since the last reset
        if (current_time - reset_global_action_at_date > 24 * 60 * 60 * 1000) {
            // Reset total_actions_today and update reset_global_action_at
            total_actions_today = 0;
            await actions_ref.update({
                "general.total_actions_today": total_actions_today,
                "general.reset_global_action_at": admin.firestore.Timestamp.now()
            });
        }

        // Check if the user has exceeded the daily limit
        if (total_actions_today >= daily_limit) {
            res.status(429).send({ status: "error", message: "Daily action limit exceeded" });
            return { proceed: false };
        }

        // Increment the total actions count
        total_actions_today += 1;

        // Update the actions document with the new values
        await actions_ref.update({
            "general.total_actions_today": total_actions_today
        });

        return { proceed: true, uid, prompt, post_id };
    } catch (error) {
        console.error(`Error during initialization and checks: ${error.message}`);
        res.status(500).send({ status: "error", message: error.message });
        return { proceed: false };
    }
}

module.exports.v1_media_ai = functions.https.onRequest(async (req, res) => {
    const initResult = await initializeAndCheck(req, res);
    if (!initResult.proceed) {
        return;
    }

    const { uid, prompt, post_id } = initResult;

    try {
        const postRef = admin.firestore().collection('posts').doc(post_id);
        const postDoc = await postRef.get();

        if (!postDoc.exists) {
            res.status(404).send({
                status: "error",
                message: "Post not found"
            });
            return;
        }

        const postData = postDoc.data();
        if (postData.general?.uid !== uid) {
            res.status(403).send({
                status: "error",
                message: "Unauthorized: UID mismatch with post owner"
            });
            return;
        }

        let cloudPath;
        const tempFilePath = path.join(os.tmpdir(), `${post_id}_temp`);

        const bucket = admin.storage().bucket();

        // Determine the path based on the file type
        const videoPath = `posts/${post_id}/resized/${post_id}_resized.mp4`;
        const imagePath = `posts/${post_id}/resized/${post_id}_resized.png`;

        // Check if video exists
        const videoFile = bucket.file(videoPath);
        const [videoExists] = await videoFile.exists();
        if (videoExists) {
            cloudPath = videoPath;
        } else {
            // Check if image exists
            const imageFile = bucket.file(imagePath);
            const [imageExists] = await imageFile.exists();
            if (imageExists) {
                cloudPath = imagePath;
            } else {
                throw new Error(`No valid media file found for post_id: ${post_id}`);
            }
        }

        // Download the file
        const file = bucket.file(cloudPath);
        await file.download({ destination: tempFilePath });
        console.log(`File downloaded locally to ${tempFilePath}`);

        const [metadata] = await file.getMetadata();
        const fileType = metadata.contentType.split('/')[0];

        let vertexInput;
        if (fileType === 'image') {
            vertexInput = {
                inlineData: {
                    mimeType: metadata.contentType,
                    data: fs.readFileSync(tempFilePath).toString('base64'),
                },
            };
        } else if (fileType === 'video') {
            vertexInput = {
                inlineData: {
                    mimeType: metadata.contentType,
                    data: fs.readFileSync(tempFilePath).toString('base64'),
                },
            };
        } else {
            const error_message = `Unsupported file type: ${fileType}`;
            await postRef.update({
                media_ai: {
                    status: "error",
                    file_type: fileType,
                    retryable: false,
                    timestamp: new Date().toISOString(),
                    error_message,
                    full_response: null,
                    title: null,
                    description: null,
                    art_category: null
                }
            });
            throw new Error(error_message);
        }

        const generativeModel = vertex_ai.preview.getGenerativeModel({
            model: 'gemini-1.5-flash-002',
            generationConfig: {
                maxOutputTokens: 500,
                temperature: 0.3,
                topP: 0.8,
            },
            safetySettings: [
                { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
                { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
                { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
                { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
            ],
        });

        const chat = generativeModel.startChat({});
        const streamResult = await chat.sendMessageStream([
            vertexInput,
            { text: prompt },
        ]);

        const aiResponse = await streamResult.response;
        const fullResponse = aiResponse;

        // Extract title, description, and art_category
        let title = null, description = null, art_category = null;

        try {
            // Parse the response and ensure it contains the `response` object
            const responseJson = JSON.parse(fullResponse.candidates[0].content.parts[0].text.match(/```json\n({.*})\n```/s)[1]);
        
            if (responseJson.response) {
                title = responseJson.response.title || null;
                description = responseJson.response.description || null;
                art_category = responseJson.response.art_category || null;
            } else {
                console.error("Response object missing in AI response");
            }
        } catch (error) {
            console.error("Error parsing AI response: ", error.message);
        }
        

        // Update Firestore with extracted and full response
        await postRef.update({
            media_ai: {
                status: "success",
                file_type: fileType,
                retryable: false,
                timestamp: new Date().toISOString(),
                error_message: null,
                full_response: fullResponse,
                title,
                description,
                art_category
            }
        });

        // Update general object with title and description
        await postRef.set({
            general: {
                title: title || admin.firestore.FieldValue.delete(),
                description: description || admin.firestore.FieldValue.delete()
            }
        }, { merge: true });

        // Update the user's document
        const userRef = admin.firestore().collection('users').doc(uid);
        const userDoc = await userRef.get();

        if (!userDoc.exists) {
            throw new Error(`User document not found for UID: ${uid}`);
        }

        const userData = userDoc.data();

        // Update the relevant post in the my_posts.posts array
        const updatedPosts = userData.my_posts.posts.map(post => {
            if (post.post_id === post_id) {
                return {
                    ...post,
                    title: title || post.title,
                    description: description || post.description
                };
            }
            return post;
        });

        // Write the updated array back to Firestore
        await userRef.update({
            "my_posts.posts": updatedPosts
        });

        res.status(200).send({
            status: "success",
            message: "AI processing completed",
            response: {
                title,
                description,
                art_category
            }
        });
    } catch (error) {
        console.error(`Error in v1_media_ai: ${error.message}`);
        res.status(500).send({
            status: "error",
            message: error.message,
        });
    } finally {
        if (fs.existsSync(tempFilePath)) {
            fs.unlinkSync(tempFilePath);
        }
    }
});

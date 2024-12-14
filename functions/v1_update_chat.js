const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { VertexAI } = require('@google-cloud/vertexai');
const path = require('path');

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
    const { uid, instruction, chat_id, prompt } = req.body;

    if (!uid || !chat_id || !prompt || !prompt.new_message) {
        res.status(400).send("Missing required parameters: uid, chat_id, or prompt.new_message");
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

        return { proceed: true, uid, instruction, chat_id, prompt };
    } catch (error) {
        console.error(`Error during initialization and checks: ${error.message}`);
        res.status(500).send({ status: "error", message: error.message });
        return { proceed: false };
    }
}

module.exports.v1_update_chat = functions.https.onRequest(async (req, res) => {
    const initResult = await initializeAndCheck(req, res);
    if (!initResult.proceed) {
        return;
    }

    const { uid, instruction, chat_id, prompt } = initResult;
    const chats_ref = admin.firestore().collection('chats');

    try {
        // Retrieve the existing chat document
        const chat_doc_ref = chats_ref.doc(chat_id);
        const chat_doc = await chat_doc_ref.get();
        if (!chat_doc.exists) {
            return res.status(404).send("Chat not found");
        }
        let chat_data = chat_doc.data();

        // Ensure messages array exists
        if (!Array.isArray(chat_data.messages)) {
            chat_data.messages = [];
        }

        // Update the context (instruction) if provided
        if (instruction) {
            chat_data.context = instruction;
        }

        // Prepare user message
        const new_user_message = {
            role: 'user',
            content: prompt.new_message,
        };
        chat_data.messages.push(new_user_message);

        // Filter out invalid messages before sending to AI
        const ai_input_messages = chat_data.messages.filter(msg => msg.role && (msg.role === 'user' || msg.role === 'assistant') && msg.content && typeof msg.content === 'string' && msg.content.trim() !== '');

        // Initialize the generative model with system instruction
        const generative_model = vertex_ai.preview.getGenerativeModel({
            model: 'gemini-1.5-flash-002',
            generationConfig: {
                maxOutputTokens: 500,
                temperature: 0.5,
                topP: 0.90,
            },
            safetySettings: [
                {
                    category: 'HARM_CATEGORY_HATE_SPEECH',
                    threshold: 'OFF',
                },
                {
                    category: 'HARM_CATEGORY_DANGEROUS_CONTENT',
                    threshold: 'OFF',
                },
                {
                    category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
                    threshold: 'OFF',
                },
                {
                    category: 'HARM_CATEGORY_HARASSMENT',
                    threshold: 'OFF',
                }
            ],
            systemInstruction: {
                parts: [
                    {
                        text: JSON.stringify(chat_data.context) || ''
                    }
                ]
            },
        });

        // Use generateContentStream for generating response
        const req_payload = {
            contents: ai_input_messages.map(msg => ({
                role: msg.role,
                parts: [{ text: msg.content }],
            })),
        };

        const streaming_resp = await generative_model.generateContentStream(req_payload);

        let aggregated_response = '';
        for await (const item of streaming_resp.stream) {
            if (item?.candidates?.[0]?.content?.parts) {
                // Extract text parts properly if it’s an array of parts
                aggregated_response += item.candidates[0].content.parts.map(part => part.text).join('');
            } else {
                aggregated_response += item?.candidates?.[0]?.content || '';
            }
        }

        // Append the assistant's response to the chat
        const new_assistant_message = {
            role: 'assistant',
            content: aggregated_response,
        };
        chat_data.messages.push(new_assistant_message);
        chat_data.updated_at = new Date().toISOString();

        // Update the chat document with both user and assistant messages
        await chat_doc_ref.set(chat_data);

        // Respond with Gemini's output
        return res.status(200).send({ status: "success", output: aggregated_response, chat_id });
    } catch (error) {
        console.error('Error occurred:', error);
        return res.status(500).send({ status: "error", message: error.message });
    }
});

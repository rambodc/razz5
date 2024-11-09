const admin = require('firebase-admin');
const { VertexAI } = require('@google-cloud/vertexai');
const functions = require('firebase-functions');

module.exports = async function runAI2(documentId, params) {
    // Directly access environment variables using functions.config()
    const vertexProject = functions.config().vertex.project;
    const vertexLocation = functions.config().vertex.location;

    // Initialize Vertex AI client using the provided project and location
    const vertexAI = new VertexAI({ project: vertexProject, location: vertexLocation });

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

    // The rest of the function logic remains the same...
    try {
        // Define Firestore references
        const functionCallRef = admin.firestore().collection('functionCalls').doc(documentId);
        const postRef = admin.firestore().collection('posts').doc(params.postId);

        // Run Firestore transaction
        await admin.firestore().runTransaction(async (transaction) => {
            const postDoc = await transaction.get(postRef);
            const functionCallDoc = await transaction.get(functionCallRef);

            if (!postDoc.exists) {
                throw new Error(`Post with ID ${params.postId} does not exist.`);
            }

            const postData = postDoc.data();
            const workflow = postData.workflow || {};
            const runAIWorkflow = workflow.runAI || {};

            if (runAIWorkflow.result === 'success') {
                throw new Error('The runAI workflow has already been successfully completed.');
            }

            if (runAIWorkflow.attempt3) {
                throw new Error('All attempts for runAI have been used.');
            }

            if (functionCallDoc.data().status === 'processing') {
                throw new Error('This function call is already being processed.');
            }

            // Mark the function call as processing
            transaction.update(functionCallRef, {
                status: 'processing'
            });

            let attempt;
            if (!runAIWorkflow.attempt1) {
                attempt = 'attempt1';
            } else if (!runAIWorkflow.attempt2) {
                attempt = 'attempt2';
            } else if (!runAIWorkflow.attempt3) {
                attempt = 'attempt3';
            }

            // Update Firestore with the current attempt
            transaction.update(postRef, {
                [`workflow.runAI.${attempt}`]: documentId
            });

            const fileUri = `gs://${functions.config().bucket.name}.appspot.com/${params.path}`;
            const file = admin.storage().bucket(`${functions.config().bucket.name}.appspot.com`).file(params.path);

            const [metadata] = await file.getMetadata();
            const mimeType = metadata.contentType;

            const validImageMimeTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/bmp', 'image/tiff', 'image/webp'];
            const validVideoMimeTypes = ['video/mp4', 'video/x-msvideo', 'video/quicktime', 'video/x-ms-wmv', 'video/x-flv', 'video/x-matroska'];

            if (!validImageMimeTypes.includes(mimeType) && !validVideoMimeTypes.includes(mimeType)) {
                console.log(`File is not a valid image or video type: ${mimeType}`);
                transaction.update(functionCallRef, {
                    status: 'error',
                    'response.result': 'error',
                    'response.errorMessage': 'File is not a valid image or video type',
                    'response.error': admin.firestore.FieldValue.serverTimestamp()
                });
                return;
            }

            const filePart = { fileData: { fileUri: fileUri, mimeType: mimeType } };
            const textPart = { text: JSON.stringify(params.prompt) };  // Stringify the prompt object
            const request = {
                contents: [{ role: 'user', parts: [textPart, filePart] }],
            };

            console.log('Request to Vertex AI with gs:// URL:', JSON.stringify(request, null, 2));

            const streamingResult = await generativeModel.generateContentStream(request);
            let responseText = '';
            for await (const item of streamingResult.stream) {
                responseText += JSON.stringify(item) + '\n';
            }
            const aggregatedResponse = await streamingResult.response;

            transaction.update(postRef, {
                'workflow.runAI.result': 'success',
                status: 'runAI',
                ai: aggregatedResponse,
            });

            transaction.update(functionCallRef, {
                status: 'completed',
                'response.result': 'success',
                'response.data': aggregatedResponse,
                'response.completed': admin.firestore.FieldValue.serverTimestamp()
            });
        });
    } catch (error) {
        console.error(`Error in runAI2 function: ${error.message}`);

        let status = 'error';
        let errorMessage = error.message;

        if (error.message.includes('already being processed')) {
            status = 'concurrencyError';
            errorMessage = 'Function call hit concurrency issue';
        }

        await admin.firestore().collection('functionCalls').doc(documentId).update({
            status: status,
            'response.errorMessage': errorMessage,
            'response.error': admin.firestore.FieldValue.serverTimestamp()
        });
    }
};

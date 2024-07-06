/*
Steps of the function:

1. Import required modules: 'firebase-admin' and 'vertexai'.
2. Export an asynchronous function 'runAI' with parameters: documentId, params, bucketName, vertexProject, and vertexLocation.
3. Initialize the Vertex AI client with the provided project and location.
4. Define the generative model configuration with specific parameters and safety settings.
5. Extract 'prompt', 'postId', and 'path' from the 'params' object.
6. Define Firestore references for 'functionCalls' and 'posts' collections.
7. Run a Firestore transaction:
    a. Retrieve the post and function call documents using 'postId' and 'documentId'.
    b. If the post document does not exist, throw an error.
    c. If the runAI workflow has already been successfully completed or all attempts have been used, throw an error.
    d. If the function call status is 'processing', throw an error.
    e. Update Firestore with the current attempt in the runAI workflow.
    f. Mark the function call as processing.
    g. Construct the file URI and retrieve the file metadata.
    h. Check if the file is a valid image or video type. If not, update the function call document with an error status and message, then return.
    i. Create file and text parts for the Vertex AI request. The 'prompt' object is stringified.
    j. Log the request for debugging purposes.
    k. Send the request to Vertex AI and handle the streaming result.
    l. Update the 'posts' document with the AI response and set the workflow result to success and post status to "runAI".
    m. Update the function call document status to 'completed' with the response data.
8. Catch and handle any errors:
    a. Log the error message.
    b. Update the function call document with the appropriate error status and message.
*/

const admin = require('firebase-admin');
const { VertexAI } = require('@google-cloud/vertexai');

module.exports = async function runAI(documentId, params, bucketName, vertexProject, vertexLocation) {
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

    const { prompt, postId, path } = params;

    const functionCallRef = admin.firestore().collection('functionCalls').doc(documentId);
    const postRef = admin.firestore().collection('posts').doc(postId);

    try {
        await admin.firestore().runTransaction(async (transaction) => {
            const postDoc = await transaction.get(postRef);
            const functionCallDoc = await transaction.get(functionCallRef);

            if (!postDoc.exists) {
                throw new Error(`Post with ID ${postId} does not exist.`);
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

            const fileUri = `gs://${bucketName}.appspot.com/${path}`;
            const file = admin.storage().bucket(`${bucketName}.appspot.com`).file(path);

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
            const textPart = { text: JSON.stringify(prompt) };  // Stringify the prompt object
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
        console.error(`Error in runAI function: ${error.message}`);

        let status = 'error';
        let errorMessage = error.message;

        if (error.message.includes('already being processed')) {
            status = 'concurrencyError';
            errorMessage = 'Function call hit concurrency issue';
        }

        await functionCallRef.update({
            status: status,
            'response.errorMessage': errorMessage,
            'response.error': admin.firestore.FieldValue.serverTimestamp()
        });
    }
};

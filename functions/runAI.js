const admin = require('firebase-admin');

module.exports = async function runAI(documentId, params, generativeModel, bucketName) {
    const { prompt, postId, path } = params;

    try {
        const fileUri = `gs://${bucketName}.appspot.com/${path}`;
        const file = admin.storage().bucket(`${bucketName}.appspot.com`).file(path);

        // Fetch file metadata from the Cloud Storage bucket
        const [metadata] = await file.getMetadata();
        const mimeType = metadata.contentType;

        // Define valid MIME types for images and videos
        const validImageMimeTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/bmp', 'image/tiff', 'image/webp'];
        const validVideoMimeTypes = ['video/mp4', 'video/x-msvideo', 'video/quicktime', 'video/x-ms-wmv', 'video/x-flv', 'video/x-matroska'];

        // Check if the file is a valid image or video based on MIME type
        if (!validImageMimeTypes.includes(mimeType) && !validVideoMimeTypes.includes(mimeType)) {
            console.log(`File is not a valid image or video type: ${mimeType}`);
            await admin.firestore().collection('functionCalls').doc(documentId).update({
                'status': 'skipped',
                'response.result': 'error',
                'response.errorMessage': 'File is not a valid image or video type',
                'response.error': admin.firestore.FieldValue.serverTimestamp()
            });
            return;
        }

        const filePart = { fileData: { fileUri: fileUri, mimeType: mimeType } };
        const textPart = { text: prompt };
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

        // Update Firestore document with the response under 'ai' map
        await admin.firestore().collection('posts').doc(postId).update({
            ai: aggregatedResponse,
        });

        // Update functionCalls document with the completion status
        await admin.firestore().collection('functionCalls').doc(documentId).update({
            'status': 'completed',
            'response.result': 'success',
            'response.data': aggregatedResponse,
            'response.completed': admin.firestore.FieldValue.serverTimestamp()
        });

    } catch (error) {
        console.error(`Error in runAI function: ${error.message}`);

        await admin.firestore().collection('functionCalls').doc(documentId).update({
            'status': 'error',
            'response.errorMessage': error.message,
            'response.error': admin.firestore.FieldValue.serverTimestamp()
        });
    }
};

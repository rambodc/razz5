/*
Steps of the function:

1. Import required modules: 'firebase-admin', 'google-cloud/storage', 'sharp', and 'path'.
2. Export an asynchronous function 'resizeImage' with parameters: documentId, params, and bucketName.
3. Extract 'getFilePath', 'storePathPath', 'resizeValues', and 'postId' from the 'params' object.
4. Define Firestore references for 'functionCalls' and 'posts' collections.
5. Run a Firestore transaction:
    a. Retrieve the post and function call documents using 'postId' and 'documentId'.
    b. If the post document does not exist, throw an error.
    c. If the resizeImage workflow has already been successfully completed or all attempts have been used, throw an error.
    d. If the function call status is 'processing', throw an error.
    e. Update Firestore with the current attempt in the resizeImage workflow.
    f. Mark the function call as processing.
6. Proceed with the image resizing:
    a. Get the file from the storage bucket and check if it exists. If not, throw an error.
    b. Download the file and split the 'resizeValues' into an array.
    c. Resize the image for each value in the array and save the resized images to the storage bucket.
    d. Generate a public URL for each resized image.
    e. Update the 'posts' document with the image URLs in a new map called 'resizedImage' and set the status to "resizedImage".
7. Update the workflow result in the 'posts' document.
8. Update the functionCalls collection with success status and response data.
9. Catch and handle any errors:
    a. Log the error message.
    b. Update the function call document with the appropriate error status and message.
*/

const admin = require('firebase-admin');
const { Storage } = require('@google-cloud/storage');
const sharp = require('sharp');
const path = require('path');

const storage = new Storage();

module.exports = async function resizeImage(documentId, params, bucketName) {
    const { getFilePath, storePathPath, resizeValues, postId } = params;

    try {
        const postRef = admin.firestore().collection('posts').doc(postId);
        const functionCallRef = admin.firestore().collection('functionCalls').doc(documentId);

        // Use Firestore transaction to set the processing flag
        await admin.firestore().runTransaction(async (transaction) => {
            const postDoc = await transaction.get(postRef);
            const functionCallDoc = await transaction.get(functionCallRef);

            if (!postDoc.exists) {
                throw new Error(`Post with ID ${postId} does not exist.`);
            }

            const postData = postDoc.data();
            const workflow = postData.workflow || {};
            const resizeImageWorkflow = workflow.resizeImage || {};

            if (resizeImageWorkflow.result === 'success') {
                throw new Error('The resizeImage workflow has already been successfully completed.');
            }

            if (resizeImageWorkflow.attempt3) {
                throw new Error('All attempts for resizeImage have been used.');
            }

            if (functionCallDoc.data().status === 'processing') {
                throw new Error('This function call is already being processed.');
            }

            // Mark the function call as processing
            transaction.update(functionCallRef, {
                'status': 'processing'
            });

            let attempt;
            if (!resizeImageWorkflow.attempt1) {
                attempt = 'attempt1';
            } else if (!resizeImageWorkflow.attempt2) {
                attempt = 'attempt2';
            } else if (!resizeImageWorkflow.attempt3) {
                attempt = 'attempt3';
            }

            // Update Firestore with the current attempt
            transaction.update(postRef, {
                [`workflow.resizeImage.${attempt}`]: documentId
            });
        });

        // Proceed with the image resizing
        const bucket = storage.bucket(`${bucketName}.appspot.com`);
        const file = bucket.file(getFilePath);
        const [fileExists] = await file.exists();

        if (!fileExists) {
            throw new Error(`File ${getFilePath} does not exist.`);
        }

        const [buffer] = await file.download();
        const resizeValueArray = resizeValues.split(',');

        const resizedImages = await Promise.all(resizeValueArray.map(async (resizeValue) => {
            const [width, height] = resizeValue.split('x').map(Number);
            const resizedBuffer = await sharp(buffer)
                .rotate() // Ensure proper orientation
                .resize({ width, height, fit: 'inside' }) // Maintain aspect ratio
                .png()
                .toBuffer();

            const fileName = path.basename(getFilePath, path.extname(getFilePath));
            const resizedFileName = `${fileName}_${resizeValue}.png`;
            const resizedFilePath = `${storePathPath}/${resizedFileName}`;
            const resizedFile = bucket.file(resizedFilePath);

            await resizedFile.save(resizedBuffer);

            const [metadata] = await resizedFile.getMetadata();
            let token = metadata.metadata ? metadata.metadata.firebaseStorageDownloadTokens : null;

            if (!token) {
                const config = {
                    action: 'read',
                    expires: '03-01-2500'
                };
                const [url] = await resizedFile.getSignedUrl(config);
                token = url.split('token=')[1];
            }

            const downloadUrl = `https://firebasestorage.googleapis.com/v0/b/${bucketName}.appspot.com/o/${encodeURIComponent(resizedFilePath)}?alt=media&token=${token}`;

            return {
                size: resizeValue,
                path: resizedFilePath,
                downloadUrl
            };
        }));

        // Update the workflow result and status
        await postRef.update({
            'workflow.resizeImage.result': 'success',
            'status': 'resizedImage',
            'resizedImage': resizedImages.reduce((map, image) => {
                map[image.size] = image.downloadUrl;
                return map;
            }, {})
        });

        // Update the functionCalls collection with success status
        await admin.firestore().collection('functionCalls').doc(documentId).update({
            'status': 'completed',
            'response.result': 'success',
            'response.data': resizedImages,
            'response.completed': admin.firestore.FieldValue.serverTimestamp()
        });
    } catch (error) {
        console.error(`Error in resizeImage function: ${error.message}`);

        let status = 'error';
        let errorMessage = error.message;

        if (error.message.includes('already being processed')) {
            status = 'concurrencyError';
            errorMessage = 'Function call hit concurrency issue';
        }

        await admin.firestore().collection('functionCalls').doc(documentId).update({
            'status': status,
            'response.errorMessage': errorMessage,
            'response.error': admin.firestore.FieldValue.serverTimestamp()
        });
    }
};

const admin = require('firebase-admin');
const { Storage } = require('@google-cloud/storage');
const sharp = require('sharp');
const path = require('path');

const storage = new Storage();

module.exports = async function resizeImage(documentId, params, bucketName) {
    const { getFilePath, storePathPath, resizeValues } = params; // Adjusted to match new parameter structure

    try {
        const bucket = admin.storage().bucket(`${bucketName}.appspot.com`);
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
                .resize({ width, height, fit: 'inside' })
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
                // If token is not available in metadata, generate a new one
                const config = {
                    action: 'read',
                    expires: '03-01-2500' // Choose an appropriate expiry date
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

        await admin.firestore().collection('functionCalls').doc(documentId).update({
            'status': 'completed',
            'response.result': 'success',
            'response.data': resizedImages,
            'response.completed': admin.firestore.FieldValue.serverTimestamp()
        });
    } catch (error) {
        console.error(`Error in resizeImage function: ${error.message}`);

        await admin.firestore().collection('functionCalls').doc(documentId).update({
            'status': 'error',
            'response.errorMessage': error.message,
            'response.error': admin.firestore.FieldValue.serverTimestamp()
        });
    }
};

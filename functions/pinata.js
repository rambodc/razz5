/*
Steps of the function:

1. Import required modules: 'firebase-admin', 'axios', 'form-data', 'fs', and 'os'.
2. Export an asynchronous function 'pinata' with parameters: documentId, params, and bucketName.
3. Extract 'postId' and 'path' from the 'params' object.
4. Define Firestore references for 'functionCalls' and 'posts' collections.
5. Run a Firestore transaction:
    a. Retrieve the post and function call documents using 'postId' and 'documentId'.
    b. If the post document does not exist, throw an error.
    c. If the ipfs workflow has already been successfully completed or all attempts have been used, throw an error.
    d. If the function call status is 'processing', throw an error.
    e. Update Firestore with the current attempt in the ipfs workflow.
    f. Mark the function call as processing.
6. Proceed with the file upload to IPFS via Pinata:
    a. Download the file from Cloud Storage.
    b. Upload the file to IPFS using Pinata's API.
    c. Get the IPFS hash and gateway URL from the response.
    d. Update the 'posts' document with the IPFS hash and URL in a new map called 'ipfs'.
7. Update the workflow result in the 'posts' document.
8. Update the functionCalls collection with success status and response data.
9. Catch and handle any errors:
    a. Log the error message.
    b. Update the function call document with the appropriate error status and message.
*/

const admin = require('firebase-admin');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const os = require('os');
const path = require('path');
const functions = require('firebase-functions');

const PINATA_JWT = functions.config().pinata.jwt; // Access the environment variable

const { Storage } = require('@google-cloud/storage');
const storage = new Storage({ projectId: functions.config().project_id });

module.exports = async function pinata(documentId, params, bucketName) {
    const { postId, path: filePath } = params;

    try {
        console.log("Starting pinata function");
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
            const ipfsWorkflow = workflow.ipfs || {};

            if (ipfsWorkflow.result === 'success') {
                throw new Error('The ipfs workflow has already been successfully completed.');
            }

            if (ipfsWorkflow.attempt3) {
                throw new Error('All attempts for ipfs have been used.');
            }

            if (functionCallDoc.data().status === 'processing') {
                throw new Error('This function call is already being processed.');
            }

            // Mark the function call as processing
            transaction.update(functionCallRef, {
                'status': 'processing'
            });

            let attempt;
            if (!ipfsWorkflow.attempt1) {
                attempt = 'attempt1';
            } else if (!ipfsWorkflow.attempt2) {
                attempt = 'attempt2';
            } else if (!ipfsWorkflow.attempt3) {
                attempt = 'attempt3';
            }

            // Update Firestore with the current attempt
            transaction.update(postRef, {
                [`workflow.ipfs.${attempt}`]: documentId
            });
        });

        // Proceed with the file upload to IPFS
        console.log("Downloading file from Cloud Storage");
        const fullBucketName = `${bucketName}.appspot.com`;
        const bucket = storage.bucket(fullBucketName);
        const file = bucket.file(filePath);
        const tempFilePath = path.join(os.tmpdir(), path.basename(filePath));

        await file.download({ destination: tempFilePath });

        console.log("Uploading file to IPFS via Pinata");
        const formData = new FormData();
        formData.append('file', fs.createReadStream(tempFilePath));

        const pinataMetadata = JSON.stringify({
            name: path.basename(filePath),
        });
        formData.append('pinataMetadata', pinataMetadata);

        const pinataOptions = JSON.stringify({
            cidVersion: 0,
        });
        formData.append('pinataOptions', pinataOptions);

        const response = await axios.post("https://api.pinata.cloud/pinning/pinFileToIPFS", formData, {
            maxBodyLength: "Infinity",
            headers: {
                'Content-Type': `multipart/form-data; boundary=${formData._boundary}`,
                'Authorization': `Bearer ${PINATA_JWT}`
            }
        });

        const ipfsHash = response.data.IpfsHash;
        const gatewayUrl = `https://gateway.pinata.cloud/ipfs/${ipfsHash}`;

        console.log("File uploaded to IPFS successfully");

        // Update the workflow result and status
        await postRef.update({
            'workflow.ipfs.result': 'success',
            'status': 'ipfs',
            'ipfs': {
                hash: ipfsHash,
                url: gatewayUrl
            }
        });

        // Update the functionCalls collection with success status
        await admin.firestore().collection('functionCalls').doc(documentId).update({
            'status': 'completed',
            'response.result': 'success',
            'response.data': {
                hash: ipfsHash,
                url: gatewayUrl
            },
            'response.completed': admin.firestore.FieldValue.serverTimestamp()
        });
    } catch (error) {
        console.error(`Error in pinata function: ${error.message}`);

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

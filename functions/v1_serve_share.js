// Updated function to serve HTML content directly and enhance logging and error handling
const functions = require('firebase-functions/v1');
const { Storage } = require('@google-cloud/storage');

// Initialize Google Cloud Storage with project ID from environment variables
const storage = new Storage({ projectId: functions.config().project_id });

exports.v1_serve_share = functions.https.onRequest(async (req, res) => {
    const shareId = req.path.split('/').pop();

    if (!shareId) {
        console.error("Request missing share ID");
        return res.status(400).send("Invalid share ID");
    }

    const bucketName = functions.config().storage.bucket;
    const filePath = `share/${shareId}/index.html`;

    try {
        console.log(`Checking existence of file: ${filePath} in bucket: ${bucketName}`);

        // Check if the file exists in Cloud Storage
        const [exists] = await storage.bucket(bucketName).file(filePath).exists();

        if (!exists) {
            console.warn(`File not found: ${filePath}`);
            return res.status(404).send("Share not found");
        }

        console.log(`File found: ${filePath}, fetching content...`);

        // Download the file content
        const [fileContent] = await storage.bucket(bucketName).file(filePath).download();

        console.log(`File content fetched successfully, serving response...`);

        // Set headers and serve the file content
        res.set('Content-Type', 'text/html');
        res.set('Cache-Control', 'public, max-age=3600'); // Optional caching
        res.send(fileContent.toString());
    } catch (error) {
        console.error("Error occurred while serving share file:", error);

        // Detailed error handling
        if (error.code === 404) {
            return res.status(404).send("Share file not found in storage");
        } else if (error.code === 403) {
            return res.status(403).send("Access denied to share file");
        } else {
            return res.status(500).send("Internal Server Error");
        }
    }
});

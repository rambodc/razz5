
// Firebase Cloud Function: v1_resize_file.js (Updated Version with Requested Changes)
const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios'); 

// Only initialize Firebase Admin if it hasn't been initialized
if (!admin.apps.length) {
    admin.initializeApp();
}

// Initialize Google Cloud Storage with project ID from environment variables
const { Storage } = require('@google-cloud/storage');
const storage = new Storage({ projectId: functions.config().project_id });

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
    const { uid, post_id, file_format } = req.body;

    if (!uid || !post_id || !file_format) {
        res.status(400).send("Missing required parameters: uid, post_id, or file_format");
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

    try {
        // Verify custom claims for the user
        const user_record = await admin.auth().getUser(uid);
        const custom_claims = user_record.customClaims;
        if (!custom_claims || custom_claims.user_status !== 'active') {
            res.status(403).send({ status: "error", message: "Unauthorized: User does not have the required permissions" });
            return { proceed: false };
        }

        // General action check before proceeding
        const actions_ref = admin.firestore().collection('actions').doc(uid);
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

        return { proceed: true, uid, post_id, file_format };
    } catch (error) {
        console.error(`Error during initialization and checks: ${error.message}`);
        res.status(500).send({ status: "error", message: error.message });
        return { proceed: false };
    }
}

module.exports.v1_resize_file = functions.https.onRequest(async (req, res) => {
    const init_result = await initializeAndCheck(req, res);
    if (!init_result.proceed) {
        return;
    }

    const { uid, post_id, file_format } = init_result;

    // Add UID Check
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

    const bucket_name = functions.config().storage.bucket;
    const bucket = storage.bucket(bucket_name);
    const original_file_path = `posts/${post_id}/original/${post_id}_original`;
    const temp_original_file_path = path.join(os.tmpdir(), `${post_id}_original`);

    let metadata = {
        post_id: post_id,
        status: "in-progress",
        type: "",
        total_attempts: 0,
        resized_files: [],
        error_message: "",
        last_attempt: {
            timestamp: null,
            result: null
        }
    };

    // Write in-progress status to Firestore early
    await postRef.set({ resized: metadata }, { merge: true });

    try {
        console.log("Reconstructing file path from Cloud Storage");
        const file = bucket.file(original_file_path);
        console.log(`Attempting to download file from path: ${original_file_path}`);

        // Check if the file exists before downloading
        const [exists] = await file.exists();
        if (!exists) {
            throw new Error(`File not found at path: ${original_file_path}`);
        }

        await file.download({ destination: temp_original_file_path });
        console.log("File downloaded successfully");



        // Retrieve metadata to determine file type
        const [fileMetadata] = await file.getMetadata();
        const fileType = fileMetadata.contentType.split('/')[0];
        console.log(`File type determined: ${fileType}`);

        metadata.total_attempts += 1;
        metadata.last_attempt.timestamp = new Date().toISOString();
        let resized_paths = [];

        if (fileType === 'image') {
            console.log("Resizing image to fit within 800x800 while maintaining aspect ratio");

            const temp_resized_image_path = path.join(os.tmpdir(), `${post_id}_resized.png`);

            // Use Sharp to auto-orient the image based on EXIF metadata and resize
            await sharp(temp_original_file_path)
                .rotate() // Automatically fixes orientation based on EXIF metadata
                .resize({
                    width: 800,
                    height: 800,
                    fit: 'inside', // Maintains aspect ratio
                })
                .toFile(temp_resized_image_path);

            console.log("Uploading resized image to Cloud Storage");
            const resized_image_storage_path = `posts/${post_id}/resized/${post_id}_resized.png`;
            await bucket.upload(temp_resized_image_path, {
                destination: resized_image_storage_path,
                metadata: {
                    contentType: 'image/png',
                },
            });

            console.log("Resized image uploaded successfully");
            resized_paths.push(resized_image_storage_path);
            metadata.resized_files.push({
                file_name: `${post_id}_resized.png`,
                type: "image",
                status: "success",
                output_path: resized_image_storage_path,
            });

            // Clean up temporary resized image file
            fs.unlinkSync(temp_resized_image_path);
        } else if (fileType === 'video') {
            console.log("Resizing video file with adaptive scaling to maintain aspect ratio");

            const resized_file_path = path.join(os.tmpdir(), `${post_id}_resized.mp4`);
            await new Promise((resolve, reject) => {
                ffmpeg(temp_original_file_path)
                    .videoCodec('libx264')
                    .audioCodec('aac')
                    .outputOptions([
                        '-vf', "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease",
                        '-preset', 'slow',
                        '-crf', '23',
                        '-pix_fmt', 'yuv420p'
                    ])
                    .output(resized_file_path)
                    .on('end', resolve)
                    .on('error', reject)
                    .run();
            });




            console.log("Uploading resized video to Cloud Storage");
            const resized_storage_path = `posts/${post_id}/resized/${post_id}_resized.mp4`;
            await bucket.upload(resized_file_path, {
                destination: resized_storage_path,
                metadata: {
                    contentType: 'video/mp4'
                }
            });

            console.log("Resized video uploaded successfully");
            resized_paths.push(resized_storage_path);
            metadata.resized_files.push({
                file_name: `${post_id}_resized.mp4`,
                type: "video",
                status: "success",
                output_path: resized_storage_path
            });

            // Trigger v1_video_thumbnail function
            console.log("Triggering v1_video_thumbnail function");
            const axios = require('axios');
            try {
                const projectId = functions.config().vertex.project; // Fetch project ID from environment variables
                const videoThumbnailUrl = `https://us-central1-${projectId}.cloudfunctions.net/v1_video_thumbnail`;
                
                const response = await axios.post(videoThumbnailUrl, {
                    uid,
                    post_id,
                    file_format: 'video',
                }, {
                    headers: {
                        Authorization: `Bearer ${req.headers.authorization.split('Bearer ')[1]}`,
                    },
                });
                
                console.log(`v1_video_thumbnail response: ${response.data}`);
            } catch (error) {
                console.error(`Error triggering v1_video_thumbnail: ${error.message}`);
            }
            
        } else if (fileType === 'audio') {
            console.log("Processing audio file to convert to mp3 format");

            const resized_audio_file_path = path.join(os.tmpdir(), `${post_id}_audio.mp3`);
            await new Promise((resolve, reject) => {
                ffmpeg(temp_original_file_path)
                    .outputOptions('-q:a', '2')
                    .output(resized_audio_file_path)
                    .on('end', resolve)
                    .on('error', reject)
                    .run();
            });

            console.log("Uploading mp3 audio to Cloud Storage");
            const resized_audio_storage_path = `posts/${post_id}/resized/${post_id}_audio.mp3`;
            await bucket.upload(resized_audio_file_path, {
                destination: resized_audio_storage_path,
                metadata: {
                    contentType: 'audio/mpeg'
                }
            });

            console.log("Audio file converted and uploaded successfully");

            // Select a random audio thumbnail
            const randomThumbnailIndex = Math.floor(Math.random() * 25) + 1; // Randomly select 1-25
            const thumbnailFileName = `audio_thumb/audio_thumb${randomThumbnailIndex}.png`;

            console.log(`Selected random thumbnail: ${thumbnailFileName}`);

            // Define destination path for the thumbnail
            const resized_thumbnail_storage_path = `posts/${post_id}/resized/${post_id}_resized.png`;

            // Copy the selected thumbnail to the resized folder
            await bucket.file(thumbnailFileName).copy(bucket.file(resized_thumbnail_storage_path));
            console.log(`Thumbnail copied to: ${resized_thumbnail_storage_path}`);

            resized_paths.push(resized_audio_storage_path, resized_thumbnail_storage_path);
            metadata.resized_files.push(
                {
                    file_name: `${post_id}_audio.mp3`,
                    type: "audio",
                    status: "success",
                    output_path: resized_audio_storage_path,
                },
                {
                    file_name: `${post_id}_resized.png`, 
                    type: "audio",
                    status: "success",
                    output_path: resized_thumbnail_storage_path,
                }
            );
        } else {

            console.log("Unsupported file type, creating a placeholder thumbnail");

            const placeholderPath = path.join(os.tmpdir(), `${post_id}_resized.png`);

            // Generate the placeholder image using Sharp
            const width = 800;
            const height = 800;
            const backgroundColor = { r: 168, g: 168, b: 168, alpha: 1 }; // Gray background
            const textColor = { r: 255, g: 255, b: 255, alpha: 1 }; // White text

            // Create the placeholder with text
            await sharp({
                create: {
                    width: width,
                    height: height,
                    channels: 4,
                    background: backgroundColor, // Background color
                },
            })
                .composite([
                    {
                        input: Buffer.from(
                            `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
                                <rect width="100%" height="100%" fill="rgba(${backgroundColor.r},${backgroundColor.g},${backgroundColor.b},${backgroundColor.alpha})" />
                                <text x="50%" y="50%" font-family="Arial, sans-serif" font-size="80" fill="rgba(${textColor.r},${textColor.g},${textColor.b},${textColor.alpha})" text-anchor="middle" dominant-baseline="middle">
                                    ${file_format.toUpperCase()}
                                </text>
                            </svg>`
                        ),
                        top: 0,
                        left: 0,
                    },
                ])
                .png()
                .toFile(placeholderPath);

            console.log("Uploading placeholder thumbnail to Cloud Storage");
            const thumbnail_storage_path = `posts/${post_id}/resized/${post_id}_resized.png`;
            await bucket.upload(placeholderPath, {
                destination: thumbnail_storage_path,
                metadata: {
                    contentType: 'image/png',
                },
            });

            metadata.resized_files.push({
                file_name: `${post_id}_thumbnail.png`,
                type: "thumbnail",
                status: "success",
                output_path: thumbnail_storage_path,
            });
        }

        metadata.status = "completed";
        metadata.type = fileType === 'image' ? 'image' : fileType === 'video' ? 'video' : fileType === 'audio' ? 'audio' : 'thumbnail';
        metadata.last_attempt.result = "success";
        
        // Update Firestore document in the posts collection
        await postRef.set({
            general: { ...postData.general, type: metadata.type, status: metadata.status }, // Update general status and type
            resized: metadata,
        }, { merge: true });

        // Update the users document and my_posts array
        const userRef = admin.firestore().collection('users').doc(uid);
        const userDoc = await userRef.get();

        if (!userDoc.exists) {
            console.error(`User document not found for UID: ${uid}`);
        } else {
            const userData = userDoc.data();

            // Find and update the specific post in the my_posts array
            const updatedPosts = userData.my_posts.posts.map((post) => {
                if (post.post_id === post_id) {
                    post.type = metadata.type; // Update the type field
                    post.status = metadata.status; // Update status to "completed"
                }
                return post;
            });

            // Update the users document with the modified posts array
            await userRef.update({
                "my_posts.posts": updatedPosts,
                "general.last_post_at": admin.firestore.Timestamp.now(), // Optional: Update general field
            });

            console.log("User document updated successfully");
        }
        
        res.status(200).send({ 
            status: "success", 
            message: "File processed and uploaded successfully", 
            resized_paths,
            type: metadata.type,
            post_id: post_id
        });
    } catch (error) {
        console.error(`Error in v1_resize_file function: ${error.message}`);

        metadata.status = "failed";
        metadata.type = fileType === 'image' ? 'image' : fileType === 'video' ? 'video' : fileType === 'audio' ? 'audio' : 'thumbnail';
        metadata.last_attempt.result = "error";
        metadata.error_message = error.message;

        // Update Firestore document in the posts collection with failure metadata
        const postRef = admin.firestore().collection('posts').doc(post_id);
        await postRef.set({ resized: metadata }, { merge: true });

        res.status(500).send({ status: "error", message: error.message });
    }
});
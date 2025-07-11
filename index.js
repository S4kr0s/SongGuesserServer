const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const axios = require('axios');
const querystring = require('querystring');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');

dotenv.config();
const app = express();
app.use(cors({
    origin: '*', // Allow all origins (or specify exact origins)
    methods: 'GET,POST,PUT,DELETE',
    allowedHeaders: 'Content-Type,Authorization'
}));
app.use(bodyParser.json());
app.use(express.json());

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const FRONTEND_URI = process.env.FRONTEND_URI;
const USERS_FILE = path.join(__dirname, 'users.json');

// Read users from the JSON file
function readUsers() {
    return JSON.parse(fs.readFileSync(USERS_FILE));
}

// Save users to the JSON file
function saveUsers(users) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// Redirect to Spotify Login
app.get('/login', (req, res) => {
    const scopes = [
        'user-read-private',
        'user-read-email',
        'user-top-read',
        'user-read-playback-state',
        'user-modify-playback-state',
        'streaming'
    ].join(' ');

    const params = querystring.stringify({
        client_id: process.env.SPOTIFY_CLIENT_ID,
        response_type: 'code',
        redirect_uri: process.env.REDIRECT_URI,
        scope: scopes
    });

    const loginUrl = `https://accounts.spotify.com/authorize?${params}`;
    
    console.log("Redirecting to:", loginUrl);
    res.redirect(loginUrl);
});

app.get('/callback', async (req, res) => {
    const code = req.query.code;

    try {
        console.log("Received code:", code);

        const response = await axios.post('https://accounts.spotify.com/api/token', null, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Authorization: 'Basic ' + Buffer.from(process.env.SPOTIFY_CLIENT_ID + ':' + process.env.SPOTIFY_CLIENT_SECRET).toString('base64')
            },
            params: new URLSearchParams({
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: process.env.REDIRECT_URI
            })
        });

        const { access_token, refresh_token } = response.data;
        console.log("Received tokens:", { access_token, refresh_token });

        // Get the user profile to save their info
        const userProfile = await axios.get('https://api.spotify.com/v1/me', {
            headers: {
                Authorization: `Bearer ${access_token}`
            }
        });

        const { id, display_name, images } = userProfile.data;
        console.log("Received user profile:", { id, display_name, images });

        // Save the user to users.json
        let users = [];
        if (fs.existsSync('./users.json')) {
            users = JSON.parse(fs.readFileSync('./users.json', 'utf8'));
        }

        // Check if the user already exists
        let user = users.find(user => user.spotifyId === id);

        if (!user) {
            // New user
            user = {
                spotifyId: id,
                displayName: display_name || id,
                accessToken: access_token,
                refreshToken: refresh_token,
                profileImage: images[0]?.url || ""
            };
            users.push(user);
            console.log(`New user added: ${display_name || id}`);
        } else {
            // Update existing user
            user.accessToken = access_token;
            user.refreshToken = refresh_token;
            user.profileImage = images[0]?.url || "";
            console.log(`User updated: ${display_name || id}`);
        }

        // Save the updated user list
        fs.writeFileSync('./users.json', JSON.stringify(users, null, 2));

        // Redirect to frontend
        res.redirect(`${process.env.FRONTEND_URI}/dashboard?accessToken=${access_token}&refreshToken=${refresh_token}`);
    } catch (error) {
        console.error("Error exchanging code for tokens:", error.response?.data || error.message);
        res.status(500).send(`Error exchanging code for tokens: ${error.response?.data || error.message}`);
    }
});


// Fetch a user's top tracks
app.get('/top-tracks/:spotifyId', async (req, res) => {
    const { spotifyId } = req.params;
    const users = readUsers();
    const user = users.find(u => u.spotifyId === spotifyId);

    if (!user) {
        return res.status(404).json({ error: 'User not found' });
    }

    try {
        const response = await axios.get('https://api.spotify.com/v1/me/top/tracks', {
            headers: {
                Authorization: `Bearer ${user.accessToken}`
            },
            params: {
                limit: 50,  // Fetch up to 50 top tracks
                time_range: 'medium_term'
            }
        });

        const tracks = response.data.items.map(track => ({
            id: track.id,
            name: track.name,
            artist: track.artists.map(a => a.name).join(', '),
            albumCover: track.album.images[0]?.url || 'https://via.placeholder.com/150',
            previewUrl: track.preview_url
        }));

        res.json(tracks);
    } catch (error) {
        console.error('Error fetching top tracks:', error);
        res.status(500).json({ error: 'Error fetching top tracks' });
    }
});

// Create a song pool from selected users
app.post('/api/create-pool', async (req, res) => {
    const { userIds } = req.body;

    if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
        console.error("No valid user IDs received");
        return res.status(400).json({ error: 'No valid users found' });
    }

    const users = readUsers().filter(user => userIds.includes(user.spotifyId));

    if (users.length === 0) {
        console.error("No matching users found");
        return res.status(404).json({ error: 'No matching users found' });
    }

    try {
        const userTracks = {};
        
        for (const user of users) {
            console.log(`Fetching tracks for user: ${user.displayName}`);

            try {
                // Fetch top 50 medium-term tracks
                const mediumTermResponse = await axios.get('https://api.spotify.com/v1/me/top/tracks', {
                    headers: {
                        Authorization: `Bearer ${user.accessToken}`
                    },
                    params: {
                        limit: 50,
                        time_range: 'medium_term'
                    }
                });

                const mediumTermTracks = mediumTermResponse.data.items.map(track => ({
                    id: track.id,
                    name: track.name,
                    artist: track.artists.map(a => a.name).join(', '),
                    albumCover: track.album.images[0]?.url || 'https://via.placeholder.com/150',
                    uri: track.uri,
                    weight: 0.7  // Medium-term weight
                }));

                // Fetch top 10 long-term tracks
                const longTermResponse = await axios.get('https://api.spotify.com/v1/me/top/tracks', {
                    headers: {
                        Authorization: `Bearer ${user.accessToken}`
                    },
                    params: {
                        limit: 10,
                        time_range: 'long_term'
                    }
                });

                const longTermTracks = longTermResponse.data.items.map(track => ({
                    id: track.id,
                    name: track.name,
                    artist: track.artists.map(a => a.name).join(', '),
                    albumCover: track.album.images[0]?.url || 'https://via.placeholder.com/150',
                    uri: track.uri,
                    weight: 1.0  // Long-term weight
                }));

                // Combine and shuffle
                const combinedTracks = [...mediumTermTracks, ...longTermTracks]
                    .filter((track, index, self) =>
                        self.findIndex(t => t.id === track.id) === index
                    );

                console.log(`Fetched ${combinedTracks.length} tracks for user: ${user.displayName}`);
                userTracks[user.spotifyId] = combinedTracks;
            } catch (error) {
                console.error(`Error fetching tracks for user ${user.displayName}:`, error.response?.data || error.message);
            }
        }

        // Round-robin distribution
        const finalTracks = [];
        let empty = false;
        while (!empty) {
            empty = true;
            for (const userId of Object.keys(userTracks)) {
                const tracks = userTracks[userId];
                if (tracks.length > 0) {
                    finalTracks.push(tracks.shift());
                    empty = false;
                }
            }
        }

        console.log(`Created song pool with ${finalTracks.length} tracks`);
        res.json(finalTracks);
    } catch (error) {
        console.error('Error creating song pool:', error);
        res.status(500).json({ error: 'Error creating song pool' });
    }
});

app.get('/api/users', (req, res) => {
    try {
        const users = JSON.parse(fs.readFileSync('./users.json', 'utf8'));
        res.json(users.map(user => ({
            id: user.spotifyId,
            name: user.displayName,
            accessToken: user.accessToken,
            refreshToken: user.refreshToken,
            profileImage: user.profileImage
        })));
    } catch (error) {
        console.error("Error reading users:", error);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});


app.listen(5000, () => {
    console.log('🚀 Server is running on port 5000');
});

const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const axios = require('axios');
const querystring = require('querystring');
const fs = require('fs');
const path = require('path');

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = 'http://127.0.0.1:5000/callback';
const FRONTEND_URI = 'http://127.0.0.1:3000';
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
    const scope = 'user-read-private user-read-email user-top-read user-read-playback-state user-modify-playback-state streaming';
    const params = querystring.stringify({
        response_type: 'code',
        client_id: CLIENT_ID,
        scope,
        redirect_uri: REDIRECT_URI,
        state: 'some-random-string'
    });
    res.redirect(`https://accounts.spotify.com/authorize?${params}`);
});

// Spotify Callback
app.get('/callback', async (req, res) => {
    const code = req.query.code || null;

    try {
        const response = await axios.post('https://accounts.spotify.com/api/token', querystring.stringify({
            grant_type: 'authorization_code',
            code,
            redirect_uri: REDIRECT_URI,
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET
        }), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        const { access_token, refresh_token } = response.data;

        // Fetch User Profile
        const userResponse = await axios.get('https://api.spotify.com/v1/me', {
            headers: { Authorization: `Bearer ${access_token}` }
        });

        const { id, display_name, images } = userResponse.data;
        const profileImage = images.length ? images[0].url : '';

        // Save to JSON
        let users = readUsers();
        const userIndex = users.findIndex(user => user.spotifyId === id);

        if (userIndex === -1) {
            users.push({
                spotifyId: id,
                displayName: display_name,
                accessToken: access_token,
                refreshToken: refresh_token,
                profileImage: profileImage
            });
        } else {
            users[userIndex].accessToken = access_token;
            users[userIndex].refreshToken = refresh_token;
            users[userIndex].displayName = display_name;
            users[userIndex].profileImage = profileImage;
        }

        saveUsers(users);

        // Redirect back to the frontend with access token
        res.redirect(`${FRONTEND_URI}/dashboard?token=${access_token}`);
    } catch (error) {
        console.error('Error exchanging code for tokens:', error);
        res.send('Error exchanging code for tokens.');
    }
});

// Get All Users
app.get('/users', (req, res) => {
    res.json(readUsers());
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
app.post('/create-pool', async (req, res) => {
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
        let allTracks = [];

        // Fetch top tracks for each user
        for (const user of users) {
            console.log(`Fetching tracks for user: ${user.displayName}`);
            try {
                const response = await axios.get('https://api.spotify.com/v1/me/top/tracks', {
                    headers: {
                        Authorization: `Bearer ${user.accessToken}`
                    },
                    params: {
                        limit: 50,
                        time_range: 'medium_term'
                    }
                });

                const tracks = response.data.items.map(track => ({
                    id: track.id,
                    name: track.name,
                    artist: track.artists.map(a => a.name).join(', '),
                    albumCover: track.album.images[0]?.url || 'https://via.placeholder.com/150',
                    uri: track.uri
                }));

                console.log(`Fetched ${tracks.length} tracks for user: ${user.displayName}`);
                allTracks.push(...tracks);
            } catch (error) {
                console.error(`Error fetching top tracks for user ${user.displayName}:`, error.response?.data || error.message);
            }
        }

        // Remove duplicates and shuffle
        const uniqueTracks = allTracks.filter((track, index, self) =>
            self.findIndex(t => t.id === track.id) === index
        );
        const shuffledTracks = uniqueTracks.sort(() => 0.5 - Math.random());

        console.log(`Created song pool with ${shuffledTracks.length} tracks`);

        res.json(shuffledTracks);
    } catch (error) {
        console.error('Error creating song pool:', error);
        res.status(500).json({ error: 'Error creating song pool' });
    }
});

app.get('/api/users', (req, res) => {
    try {
        const users = JSON.parse(fs.readFileSync('./users.json', 'utf8'));
        res.json(users);
    } catch (error) {
        console.error("Error reading users:", error);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

app.post('/api/create-pool', async (req, res) => {
    try {
        const { userIds } = req.body;
        
        if (!userIds || userIds.length === 0) {
            return res.status(400).json({ error: 'No users selected' });
        }

        // Load user tokens from the JSON file
        const users = JSON.parse(fs.readFileSync('./users.json', 'utf8'));
        const selectedUsers = users.filter(user => userIds.includes(user.spotifyId));

        // Fetch tracks for each selected user
        const trackPromises = selectedUsers.map(async user => {
            const token = user.accessToken;
            const response = await axios.get('https://api.spotify.com/v1/me/top/tracks', {
                headers: {
                    Authorization: `Bearer ${token}`
                },
                params: {
                    limit: 20,
                    time_range: 'medium_term'
                }
            });

            return response.data.items.map(track => ({
                uri: track.uri,
                artist: track.artists.map(artist => artist.name).join(", "),
                name: track.name,
                albumCover: track.album.images[0]?.url || ""
            }));
        });

        // Flatten the track lists
        const allTracks = (await Promise.all(trackPromises)).flat();

        res.json(allTracks);
    } catch (error) {
        console.error("Error creating pool:", error);
        res.status(500).json({ error: 'Failed to create pool' });
    }
});


app.listen(5000, () => {
    console.log('🚀 Server is running on port 5000');
});

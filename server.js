// Import necessary modules
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const cors = require('cors');

// Initialize Express app and HTTP server
const app = express();
const server = http.createServer(app);

// Use CORS for cross-origin requests
app.use(cors());
app.use(express.json());

// Initialize Socket.IO server with CORS options
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Configure PostgreSQL connection pool
// IMPORTANT: The `DATABASE_URL` environment variable is automatically provided by Render.com
// We've also added the `ssl` option for secure connections to NeonDB.
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// Test the database connection
pool.connect()
    .then(client => {
        console.log("Database connection successful!");
        client.release();
    })
    .catch(err => {
        console.error("Database connection failed:", err.stack);
    });

// API endpoint to create a new game
app.post('/api/create-game', async (req, res) => {
    const { player_host_name, socket_id } = req.body;
    console.log(`Received request to create game for player: ${player_host_name}`);
    console.log(`Socket ID: ${socket_id}`);

    try {
        const game_id = Math.random().toString(36).substring(2, 8).toUpperCase();
        console.log(`Generated Game ID: ${game_id}`);

        // Insert new game into the database
        const result = await pool.query(
            'INSERT INTO games(game_id, player_host_name, player_host_socket, status) VALUES($1, $2, $3, $4) RETURNING *',
            [game_id, player_host_name, socket_id, 'waiting']
        );

        console.log("Game created successfully in DB:", result.rows[0]);
        res.status(201).json({ success: true, game: result.rows[0] });
    } catch (err) {
        console.error("Error creating game:", err);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

// API endpoint to join a game
app.post('/api/join-game', async (req, res) => {
    const { game_id, player_join_name, socket_id } = req.body;
    console.log(`Received request to join game ${game_id} for player: ${player_join_name}`);
    console.log(`Socket ID: ${socket_id}`);

    try {
        // Find the game and update with the second player's info
        const result = await pool.query(
            'UPDATE games SET player_join_name = $1, player_join_socket = $2, status = $3 WHERE game_id = $4 AND status = $5 RETURNING *',
            [player_join_name, socket_id, 'ready', game_id, 'waiting']
        );

        if (result.rows.length > 0) {
            console.log("Player joined game successfully:", result.rows[0]);
            res.status(200).json({ success: true, game: result.rows[0] });
        } else {
            console.warn(`Could not join game ${game_id}. Game may be full or not exist.`);
            res.status(404).json({ success: false, message: 'Game not found or is already full.' });
        }
    } catch (err) {
        console.error("Error joining game:", err);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log(`A user connected with socket ID: ${socket.id}`);

    socket.on('disconnect', () => {
        console.log(`User disconnected with socket ID: ${socket.id}`);
    });
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

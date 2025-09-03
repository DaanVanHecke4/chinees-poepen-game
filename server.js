const express = require('express');
const { Pool } = require('pg');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors'); // Importeer de CORS-middleware
const path = require('path');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: "*", // Sta alle origins toe voor Socket.IO
        methods: ["GET", "POST"]
    },
    transports: ['websocket', 'polling'],
    allowUpgrades: true,
    path: '/socket.io/'
});

// Gebruik de CORS-middleware voor Express-routes
app.use(cors());

// Maak een databasepool aan met de DATABASE_URL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

// Middleware om JSON-requests te parsen
app.use(express.json());

// Serveer statische bestanden vanuit de 'public' map
app.use(express.static(path.join(__dirname, 'public')));

// API-route om een nieuw spel aan te maken
app.post('/api/create-game', async (req, res) => {
    try {
        const { username } = req.body;
        const gameId = Math.random().toString(36).substring(2, 8).toUpperCase();
        const client = await pool.connect();
        const result = await client.query('INSERT INTO games (game_id, players) VALUES ($1, $2) RETURNING *', [gameId, JSON.stringify([{ id: socket.id, username }])]);
        client.release();
        res.status(201).json({ success: true, gameId });
    } catch (error) {
        console.error('Fout bij het aanmaken van een spel:', error);
        res.status(500).json({ success: false, message: 'Fout bij het aanmaken van een spel' });
    }
});

// API-route om je aan te sluiten bij een spel
app.post('/api/join-game', async (req, res) => {
    try {
        const { gameId, username } = req.body;
        const client = await pool.connect();
        const game = await client.query('SELECT * FROM games WHERE game_id = $1', [gameId]);
        
        if (game.rows.length === 0) {
            client.release();
            return res.status(404).json({ success: false, message: 'Spel niet gevonden' });
        }

        const players = game.rows[0].players;
        if (players.length >= 4) {
            client.release();
            return res.status(400).json({ success: false, message: 'Spel is vol' });
        }

        const newPlayer = { id: socket.id, username };
        players.push(newPlayer);

        await client.query('UPDATE games SET players = $1 WHERE game_id = $2', [JSON.stringify(players), gameId]);
        client.release();
        
        res.status(200).json({ success: true, message: 'Aangesloten bij spel', players });
    } catch (error) {
        console.error('Fout bij het aansluiten bij een spel:', error);
        res.status(500).json({ success: false, message: 'Fout bij het aansluiten bij een spel' });
    }
});

// Socket.IO-connectie
io.on('connection', (socket) => {
    console.log('Een gebruiker is verbonden:', socket.id);

    socket.on('disconnect', () => {
        console.log('Gebruiker is verbroken:', socket.id);
    });

    socket.on('join_game', (gameId) => {
        socket.join(gameId);
        console.log(`Gebruiker ${socket.id} is aangesloten bij spel: ${gameId}`);
        io.to(gameId).emit('player_joined', socket.id);
    });
});

// Start de server
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
    console.log(`Server draait op http://localhost:${PORT}`);
    console.log('Verbonden met de Neon database!');
});

// Initialiseer de database
async function initializeDatabase() {
    try {
        const client = await pool.connect();
        await client.query('CREATE TABLE IF NOT EXISTS games (game_id VARCHAR(255) PRIMARY KEY, players JSONB, state JSONB)');
        client.release();
        console.log('Database geïnitialiseerd. "games" tabel is klaar.');
    } catch (error) {
        console.error('Fout bij het initialiseren van de database:', error);
    }
}
initializeDatabase();

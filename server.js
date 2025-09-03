// Importeer de benodigde modules
const express = require('express');
const { Pool } = require('pg');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

// Maak een Express-app aan
const app = express();
const server = http.createServer(app);

// Gebruik CORS-middleware
app.use(cors());
app.use(express.json());

// Socket.IO-server
const io = new Server(server, {
  cors: {
    origin: '*',
  },
});

// Databaseverbinding met Neon DB
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Initialiseer de database
async function initDb() {
  try {
    const client = await pool.connect();
    await client.query(`
      CREATE TABLE IF NOT EXISTS games (
        game_id VARCHAR(255) PRIMARY KEY,
        player_host_id VARCHAR(255),
        player_host_name VARCHAR(255),
        player_join_id VARCHAR(255),
        player_join_name VARCHAR(255),
        game_status VARCHAR(50),
        board_state JSONB
      );
    `);
    client.release();
    console.log('Database geïnitialiseerd. "games" tabel is klaar.');
  } catch (err) {
    console.error('Fout bij het initialiseren van de database:', err);
  }
}

// Roep de functies aan bij het opstarten
initDb();

// API-route om een nieuw spel aan te maken
app.post('/api/create-game', async (req, res) => {
  try {
    const { player_host_name, socket_id } = req.body;
    const game_id = Math.random().toString(36).substring(2, 8).toUpperCase();
    
    const result = await pool.query(
      `INSERT INTO games (game_id, player_host_id, player_host_name, game_status, board_state)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [game_id, socket_id, player_host_name, 'waiting', {}]
    );

    res.status(200).json({ success: true, game: result.rows[0] });
  } catch (err) {
    console.error("Fout bij het aanmaken van een nieuw spel:", err);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

// API-route om mee te doen aan een spel
app.post('/api/join-game', async (req, res) => {
  try {
    const { game_id, player_join_name, socket_id } = req.body;
    const result = await pool.query(
      `UPDATE games SET player_join_id = $1, player_join_name = $2, game_status = 'playing'
       WHERE game_id = $3 RETURNING *`,
      [socket_id, player_join_name, game_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Game not found' });
    }

    res.status(200).json({ success: true, game: result.rows[0] });
  } catch (err) {
    console.error("Fout bij het meedoen aan een spel:", err);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

// Real-time verbindingen met Socket.IO
io.on('connection', (socket) => {
  console.log('Een gebruiker is verbonden:', socket.id);

  socket.on('disconnect', () => {
    console.log('Een gebruiker is ontkoppeld:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server draait op poort ${PORT}`);
});

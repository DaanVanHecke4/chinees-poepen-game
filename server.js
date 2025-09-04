// Bestand: server.js
// Deze server is geschreven in Node.js met Express en socket.io
const express = require('express');
const { Pool } = require('pg');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Zorg ervoor dat de poort van de omgeving wordt gebruikt
const PORT = process.env.PORT || 3000;

// Middleware om JSON-body's te parseren
app.use(express.json());

// Configuratie voor de PostgreSQL-database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Endpoint om een nieuw spel te maken
app.post('/games', async (req, res) => {
  const { playerHost, gameId } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO games (game_id, player_host) VALUES ($1, $2) RETURNING *',
      [gameId, playerHost]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Fout bij het maken van het spel:', err);
    res.status(500).json({ error: 'Interne serverfout' });
  }
});

// Endpoint om een speler toe te voegen aan een spel
app.post('/games/:gameId/join', async (req, res) => {
  const { gameId } = req.params;
  const { playerId } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO game_players (game_id, player_id) VALUES ($1, $2) RETURNING *',
      [gameId, playerId]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Fout bij het toevoegen van een speler aan het spel:', err);
    res.status(500).json({ error: 'Interne serverfout' });
  }
});

// Luisteren naar socket.io-verbindingen
io.on('connection', (socket) => {
  console.log('Een gebruiker is verbonden');

  // Deelnemen aan een spel
  socket.on('joinGame', (gameId) => {
    socket.join(gameId);
    console.log(`Gebruiker ${socket.id} is toegetreden tot spel ${gameId}`);
  });

  // Een zet plaatsen
  socket.on('makeMove', ({ gameId, move }) => {
    // Hier moet de spel-logica komen
    console.log(`Zet ontvangen in spel ${gameId}:`, move);
    // Uitzenden naar alle spelers in het spel
    io.to(gameId).emit('updateGame', move);
  });

  // Ontkoppelen
  socket.on('disconnect', () => {
    console.log('Een gebruiker is ontkoppeld');
  });
});

// Start de server
server.listen(PORT, () => {
  console.log(`Server draait op poort ${PORT}`);
});

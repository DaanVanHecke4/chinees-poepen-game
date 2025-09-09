const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// GET-route om de serverstatus te controleren
app.get('/', (req, res) => {
    res.send('Server draait.');
});

// GET-route voor alle games (voor de lobby)
app.get('/games', async (req, res) => {
    try {
        const result = await pool.query('SELECT game_id, player_host FROM games WHERE is_started = false');
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Fout bij het ophalen van games. Controleer de serverlogs.');
    }
});

// POST-route om een nieuw spel aan te maken
app.post('/games', async (req, res) => {
    const { game_id, player_host } = req.body;
    try {
        const client = await pool.connect();
        await client.query('BEGIN');
        
        await client.query('INSERT INTO games (game_id, player_host, is_started) VALUES ($1, $2, false)', [game_id, player_host]);
        await client.query('INSERT INTO game_players (game_id, player_id) VALUES ($1, $2)', [game_id, player_host]);

        await client.query('COMMIT');
        client.release();
        res.status(201).json({ message: 'Spel succesvol aangemaakt', game_id: game_id });
    } catch (err) {
        console.error('Fout bij het aanmaken van het spel:', err);
        res.status(500).json({ error: 'Fout bij het aanmaken van het spel. Controleer de server.' });
    }
});

// GET-route om spelers in een lobby te krijgen
app.get('/games/:game_id/players', async (req, res) => {
    const { game_id } = req.params;
    try {
        const result = await pool.query('SELECT player_id FROM game_players WHERE game_id = $1', [game_id]);
        res.json(result.rows);
    } catch (err) {
        console.error('Fout bij het ophalen van spelers:', err);
        res.status(500).json({ error: 'Fout bij het ophalen van spelers. Controleer de server.' });
    }
});

// NIEUWE POST-route om een game te starten
app.post('/games/:game_id/start', async (req, res) => {
    const { game_id } = req.params;
    const { player_id } = req.body;
    
    try {
        // Controleer of de speler de host is
        const hostCheck = await pool.query('SELECT player_host FROM games WHERE game_id = $1', [game_id]);
        if (hostCheck.rows.length === 0 || hostCheck.rows[0].player_host !== player_id) {
            return res.status(403).json({ error: 'Alleen de host kan het spel starten.' });
        }
        
        // Controleer of er genoeg spelers zijn (minimaal 2)
        const playersCheck = await pool.query('SELECT COUNT(*) FROM game_players WHERE game_id = $1', [game_id]);
        const playerCount = parseInt(playersCheck.rows[0].count, 10);
        if (playerCount < 2) {
            return res.status(400).json({ error: 'Niet genoeg spelers om te starten. Minimaal 2 spelers nodig.' });
        }

        // Update de game-status naar gestart
        await pool.query('UPDATE games SET is_started = true WHERE game_id = $1', [game_id]);
        
        res.json({ message: 'Spel succesvol gestart.' });
    } catch (err) {
        console.error('Fout bij het starten van het spel:', err);
        res.status(500).json({ error: 'Fout bij het starten van het spel. Controleer de server.' });
    }
});

app.listen(port, () => {
    console.log(`Server draait op poort ${port}`);
});

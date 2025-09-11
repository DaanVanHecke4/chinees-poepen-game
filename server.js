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

// Functie om een standaard kaartspel te genereren
const createDeck = () => {
    const suits = ['harten', 'ruiten', 'schoppen', 'klaveren'];
    const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'boer', 'dame', 'heer', 'aas'];
    let deck = [];
    for (const suit of suits) {
        for (const value of values) {
            deck.push({ value, suit });
        }
    }
    return deck;
};

// Functie om een stapel kaarten te schudden
const shuffleDeck = (deck) => {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
};

// GET-route om de serverstatus te controleren
app.get('/', (req, res) => {
    res.send('Server draait.');
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

// POST-route om een speler toe te voegen aan een bestaand spel
app.post('/games/:game_id/players', async (req, res) => {
    const { game_id } = req.params;
    const { player_id } = req.body;
    
    try {
        const gameCheck = await pool.query('SELECT is_started FROM games WHERE game_id = $1', [game_id]);
        if (gameCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Spel niet gevonden.' });
        }
        if (gameCheck.rows[0].is_started) {
            return res.status(400).json({ error: 'Spel is al gestart. U kunt niet deelnemen.' });
        }
        await pool.query('INSERT INTO game_players (game_id, player_id) VALUES ($1, $2)', [game_id, player_id]);
        res.status(201).json({ message: 'Speler succesvol toegevoegd aan de lobby.' });
    } catch (err) {
        console.error('Fout bij het toevoegen van speler:', err);
        res.status(500).json({ error: 'Fout bij het toevoegen van speler. Controleer de server.' });
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

// POST-route om een game te starten en kaarten uit te delen
app.post('/games/:game_id/start', async (req, res) => {
    const { game_id } = req.params;
    const { player_id } = req.body;
    
    try {
        const hostCheck = await pool.query('SELECT player_host FROM games WHERE game_id = $1', [game_id]);
        if (hostCheck.rows.length === 0 || hostCheck.rows[0].player_host !== player_id) {
            return res.status(403).json({ error: 'Alleen de host kan het spel starten.' });
        }
        
        const playersResult = await pool.query('SELECT player_id FROM game_players WHERE game_id = $1', [game_id]);
        const players = playersResult.rows.map(row => row.player_id);
        
        if (players.length < 2) {
            return res.status(400).json({ error: 'Niet genoeg spelers om te starten. Minimaal 2 spelers nodig.' });
        }

        const deck = shuffleDeck(createDeck());
        const discardPile = [deck.pop()];
        const hands = {};
        for (const player of players) {
            hands[player] = deck.splice(0, 7);
        }

        await pool.query('UPDATE games SET is_started = true, current_player = $1, deck = $2, discard_pile = $3, player_hands = $4 WHERE game_id = $5',
            [players[0], JSON.stringify(deck), JSON.stringify(discardPile), JSON.stringify(hands), game_id]
        );
        
        res.json({ message: 'Spel succesvol gestart.' });
    } catch (err) {
        console.error('Fout bij het starten van het spel:', err);
        res.status(500).json({ error: 'Fout bij het starten van het spel. Controleer de server.' });
    }
});

// GET-route om de spelstatus op te halen voor een specifieke speler
app.get('/games/:game_id/state/:player_id', async (req, res) => {
    const { game_id, player_id } = req.params;
    try {
        const result = await pool.query('SELECT current_player, deck, discard_pile, player_hands FROM games WHERE game_id = $1', [game_id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Spel niet gevonden.' });
        }
        const gameState = result.rows[0];
        const hands = JSON.parse(gameState.player_hands);

        res.json({
            current_player: gameState.current_player,
            discard_pile_top: JSON.parse(gameState.discard_pile).slice(-1)[0],
            hand: hands[player_id],
            status_message: gameState.current_player === player_id ? 'Het is jouw beurt.' : `Wachten op ${gameState.current_player}.`
        });
    } catch (err) {
        console.error('Fout bij het ophalen van de spelstatus:', err);
        res.status(500).json({ error: 'Fout bij het ophalen van de spelstatus.' });
    }
});

// POST-route om een kaart te trekken
app.post('/games/:game_id/draw_card', async (req, res) => {
    const { game_id } = req.params;
    const { player_id } = req.body;
    try {
        const result = await pool.query('SELECT current_player, deck, player_hands FROM games WHERE game_id = $1', [game_id]);
        const gameState = result.rows[0];

        if (gameState.current_player !== player_id) {
            return res.status(403).json({ error: 'Het is niet jouw beurt.' });
        }

        const deck = JSON.parse(gameState.deck);
        if (deck.length === 0) {
            // TODO: Logica om de afgelegde stapel te schudden en opnieuw te gebruiken
            return res.status(400).json({ error: 'De trekstapel is leeg.' });
        }
        
        const card = deck.pop();
        const hands = JSON.parse(gameState.player_hands);
        hands[player_id].push(card);

        await pool.query('UPDATE games SET deck = $1, player_hands = $2 WHERE game_id = $3',
            [JSON.stringify(deck), JSON.stringify(hands), game_id]
        );
        
        res.json({ message: 'Kaart getrokken.' });
    } catch (err) {
        console.error('Fout bij het trekken van een kaart:', err);
        res.status(500).json({ error: 'Fout bij het trekken van een kaart.' });
    }
});

// POST-route om een kaart te spelen
app.post('/games/:game_id/play_card', async (req, res) => {
    const { game_id } = req.params;
    const { player_id, card } = req.body;
    try {
        const result = await pool.query('SELECT current_player, discard_pile, player_hands FROM games WHERE game_id = $1', [game_id]);
        const gameState = result.rows[0];

        if (gameState.current_player !== player_id) {
            return res.status(403).json({ error: 'Het is niet jouw beurt.' });
        }

        const hands = JSON.parse(gameState.player_hands);
        const playerHand = hands[player_id];
        const discardPile = JSON.parse(gameState.discard_pile);
        const topCard = discardPile.slice(-1)[0];
        
        // Controleer of de kaart speelbaar is
        if (card.value !== topCard.value && card.suit !== topCard.suit) {
            return res.status(400).json({ error: 'Ongeldige zet. Kaart moet overeenkomen in waarde of kleur.' });
        }

        const cardIndex = playerHand.findIndex(c => c.value === card.value && c.suit === card.suit);
        if (cardIndex === -1) {
            return res.status(400).json({ error: 'Kaart niet in je hand.' });
        }

        const playedCard = playerHand.splice(cardIndex, 1)[0];
        discardPile.push(playedCard);
        
        await pool.query('UPDATE games SET player_hands = $1, discard_pile = $2 WHERE game_id = $3',
            [JSON.stringify(hands), JSON.stringify(discardPile), game_id]
        );
        
        res.json({ message: 'Kaart gespeeld.' });
    } catch (err) {
        console.error('Fout bij het spelen van de kaart:', err);
        res.status(500).json({ error: 'Fout bij het spelen van de kaart.' });
    }
});

// POST-route om de beurt te beëindigen
app.post('/games/:game_id/end_turn', async (req, res) => {
    const { game_id } = req.params;
    const { player_id } = req.body;
    try {
        const result = await pool.query('SELECT current_player FROM games WHERE game_id = $1', [game_id]);
        if (result.rows.length === 0 || result.rows[0].current_player !== player_id) {
            return res.status(403).json({ error: 'Het is niet jouw beurt.' });
        }
        
        // Bepaal de volgende speler in de beurtvolgorde
        const playersResult = await pool.query('SELECT player_id FROM game_players WHERE game_id = $1', [game_id]);
        const players = playersResult.rows.map(row => row.player_id);
        const currentIndex = players.indexOf(player_id);
        const nextIndex = (currentIndex + 1) % players.length;
        const nextPlayer = players[nextIndex];

        await pool.query('UPDATE games SET current_player = $1 WHERE game_id = $2', [nextPlayer, game_id]);
        
        res.json({ message: 'Beurt beëindigd.' });
    } catch (err) {
        console.error('Fout bij het beëindigen van de beurt:', err);
        res.status(500).json({ error: 'Fout bij het beëindigen van de beurt.' });
    }
});

app.listen(port, () => {
    console.log(`Server draait op poort ${port}`);
});

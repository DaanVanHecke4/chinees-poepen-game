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

let games = {};

// Functie om een nieuw deck te maken en te schudden
const createDeck = () => {
    const suits = ['♥', '♦', '♣', '♠'];
    const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    let deck = [];
    for (let suit of suits) {
        for (let value of values) {
            deck.push({ value, suit });
        }
    }
    // Schud het deck
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
};

// Functie om de game state te initialiseren
const initializeGameState = (gameId, players) => {
    let deck = createDeck();
    let hands = {};
    for (const player of players) {
        hands[player.player_id] = deck.splice(0, 7);
    }
    games[gameId] = {
        players: players.map(p => p.player_id),
        hands: hands,
        discard_pile: [deck.pop()],
        draw_pile: deck,
        current_turn: players[0].player_id,
        status_message: `${players[0].player_id} is aan de beurt.`,
    };
};

// GET-route om de serverstatus te controleren
app.get('/status', (req, res) => {
    res.json({ status: 'ok' });
});

// GET-route voor alle games (voor de lobby)
app.get('/games', async (req, res) => {
    try {
        const result = await pool.query('SELECT game_id, player_host FROM games WHERE is_started = false');
        res.json(result.rows);
    } catch (err) {
        console.error('Fout bij het ophalen van games:', err.message);
        res.status(500).send('Fout bij het ophalen van games. Controleer de serverlogs.');
    }
});

// GET-route om de startstatus van een spel te controleren
app.get('/games/:game_id/status', async (req, res) => {
    const { game_id } = req.params;
    try {
        const result = await pool.query('SELECT is_started FROM games WHERE game_id = $1', [game_id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Spel niet gevonden.' });
        }
        res.json({ is_started: result.rows[0].is_started });
    } catch (err) {
        console.error('Fout bij het ophalen van de spelstatus:', err.message);
        res.status(500).json({ error: 'Fout bij het ophalen van de spelstatus. Controleer de server.' });
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
        console.error('Fout bij het aanmaken van het spel:', err.message);
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
        console.error('Fout bij het toevoegen van speler:', err.message);
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
        console.error('Fout bij het ophalen van spelers:', err.message);
        res.status(500).json({ error: 'Fout bij het ophalen van spelers. Controleer de server.' });
    }
});

// POST-route om een game te starten
app.post('/games/:game_id/start', async (req, res) => {
    const { game_id } = req.params;
    const { player_id } = req.body;
    
    try {
        const hostCheck = await pool.query('SELECT player_host FROM games WHERE game_id = $1', [game_id]);
        if (hostCheck.rows.length === 0 || hostCheck.rows[0].player_host !== player_id) {
            return res.status(403).json({ error: 'Alleen de host kan het spel starten.' });
        }
        
        const playersCheck = await pool.query('SELECT player_id FROM game_players WHERE game_id = $1', [game_id]);
        const players = playersCheck.rows;
        if (players.length < 2) {
            return res.status(400).json({ error: 'Niet genoeg spelers om te starten. Minimaal 2 spelers nodig.' });
        }

        await pool.query('UPDATE games SET is_started = true WHERE game_id = $1', [game_id]);
        
        // Initialiseer de game state in-memory
        initializeGameState(game_id, players);

        res.json({ message: 'Spel succesvol gestart.' });
    } catch (err) {
        console.error('Fout bij het starten van het spel:', err.message);
        res.status(500).json({ error: 'Fout bij het starten van het spel. Controleer de server.' });
    }
});

// GET-route om de game state op te halen
app.get('/games/:game_id/state/:player_id', async (req, res) => {
    const { game_id, player_id } = req.params;
    const gameState = games[game_id];
    
    if (!gameState) {
        return res.status(404).json({ error: 'Spel niet gevonden.' });
    }
    
    const isMyTurn = gameState.current_turn === player_id;
    
    res.json({
        current_player: gameState.current_turn,
        status_message: gameState.status_message,
        discard_pile_top: gameState.discard_pile[gameState.discard_pile.length - 1],
        hand: gameState.hands[player_id],
        is_my_turn: isMyTurn
    });
});

// POST-route om een kaart te spelen
app.post('/games/:game_id/play_card', async (req, res) => {
    const { game_id } = req.params;
    const { player_id, card } = req.body;
    
    const gameState = games[game_id];
    if (!gameState) {
        console.error(`404: Spel met ID ${game_id} niet gevonden in in-memory state.`);
        return res.status(404).json({ error: 'Spel niet gevonden.' });
    }
    if (gameState.current_turn !== player_id) {
        console.error(`400: Het is niet de beurt van ${player_id}. Huidige beurt is van ${gameState.current_turn}.`);
        return res.status(400).json({ error: 'Het is niet jouw beurt.' });
    }

    const topCard = gameState.discard_pile[gameState.discard_pile.length - 1];
    
    console.log(`Poging om kaart te spelen:`, { player: player_id, card, topCard });
    
    // Check if the card can be played (same suit or same value)
    if (card.suit === topCard.suit || card.value === topCard.value || card.value === '8') {
        // Verwijder de kaart uit de hand van de speler
        const hand = gameState.hands[player_id];
        const cardIndex = hand.findIndex(c => c.value === card.value && c.suit === card.suit);
        if (cardIndex > -1) {
            hand.splice(cardIndex, 1);
            // Voeg de kaart toe aan de aflegstapel
            gameState.discard_pile.push(card);
            
            // Logica voor de volgende beurt
            const currentPlayerIndex = gameState.players.indexOf(player_id);
            const nextPlayerIndex = (currentPlayerIndex + 1) % gameState.players.length;
            gameState.current_turn = gameState.players[nextPlayerIndex];
            gameState.status_message = `Kaart gespeeld. Nu is ${gameState.current_turn} aan de beurt.`;
            console.log(`Kaart succesvol gespeeld. Nieuwe beurt voor: ${gameState.current_turn}`);

            // Stuur de bijgewerkte state naar de client
            res.json({ message: 'Kaart succesvol gespeeld.', gameState });
        } else {
            console.error(`400: Kaart ${JSON.stringify(card)} niet gevonden in de hand van ${player_id}.`);
            res.status(400).json({ error: 'Deze kaart zit niet in je hand.' });
        }
    } else {
        console.error(`400: Kaart ${JSON.stringify(card)} kan niet worden gespeeld op ${JSON.stringify(topCard)}.`);
        res.status(400).json({ error: 'Je kunt deze kaart niet spelen. De waarde of het symbool moet overeenkomen met de aflegstapel, of het moet een 8 zijn.' });
    }
});

// POST-route om een kaart te trekken
app.post('/games/:game_id/draw_card', async (req, res) => {
    const { game_id } = req.params;
    const { player_id } = req.body;

    const gameState = games[game_id];
    if (!gameState || gameState.current_turn !== player_id) {
        return res.status(400).json({ error: 'Het is niet jouw beurt.' });
    }

    // Pak een kaart van de trekstapel
    const card = gameState.draw_pile.pop();
    if (!card) {
        // Shuffle discard pile to create a new draw pile
        const discardTop = gameState.discard_pile.pop();
        gameState.draw_pile = gameState.discard_pile;
        gameState.discard_pile = [discardTop];
        const newDeck = gameState.draw_pile;
        for (let i = newDeck.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [newDeck[i], newDeck[j]] = [newDeck[j], newDeck[i]];
        }
        gameState.draw_pile = newDeck;
        const newCard = gameState.draw_pile.pop();
        gameState.hands[player_id].push(newCard);
        gameState.status_message = `${player_id} heeft een kaart getrokken. Trekstapel gereshuffeld.`;
    } else {
        gameState.hands[player_id].push(card);
        gameState.status_message = `${player_id} heeft een kaart getrokken.`;
    }
    
    // Ga naar de volgende beurt na het trekken
    const currentPlayerIndex = gameState.players.indexOf(player_id);
    const nextPlayerIndex = (currentPlayerIndex + 1) % gameState.players.length;
    gameState.current_turn = gameState.players[nextPlayerIndex];

    res.json({ message: 'Kaart succesvol getrokken.', gameState });
});

// POST-route om de beurt te beëindigen
app.post('/games/:game_id/end_turn', async (req, res) => {
    const { game_id } = req.params;
    const { player_id } = req.body;

    const gameState = games[game_id];
    if (!gameState || gameState.current_turn !== player_id) {
        return res.status(400).json({ error: 'Het is niet jouw beurt.' });
    }

    // Ga naar de volgende beurt
    const currentPlayerIndex = gameState.players.indexOf(player_id);
    const nextPlayerIndex = (currentPlayerIndex + 1) % gameState.players.length;
    gameState.current_turn = gameState.players[nextPlayerIndex];
    gameState.status_message = `${player_id} heeft zijn beurt beëindigd. Nu is ${gameState.current_turn} aan de beurt.`;

    res.json({ message: 'Beurt succesvol beëindigd.', gameState });
});

app.listen(port, () => {
    console.log(`Server draait op poort ${port}`);
});

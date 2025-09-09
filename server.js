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

// Class to represent a standard 52-card deck
class Deck {
    constructor() {
        this.cards = [];
        const suits = ['♥', '♦', '♠', '♣'];
        const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
        for (const suit of suits) {
            for (const rank of ranks) {
                this.cards.push({ suit, rank });
            }
        }
    }

    shuffle() {
        for (let i = this.cards.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]];
        }
    }

    deal(numCards) {
        return this.cards.splice(0, numCards);
    }
}

// Function to get the value of a card for comparison
const getCardValue = (card) => {
    const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    return ranks.indexOf(card.rank);
};

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
        res.status(201).json({ message: 'Spel aangemaakt en host toegevoegd.', gameId: game_id });
    } catch (err) {
        await client.query('ROLLBACK');
        client.release();
        console.error(err);
        res.status(500).json({ error: 'Fout bij het aanmaken van het spel. Controleer de serverlogs.' });
    }
});

// GET-route om spelers van een specifieke game op te halen
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

// POST-route om een speler toe te voegen aan een spel
app.post('/games/:game_id/players', async (req, res) => {
    const { game_id } = req.params;
    const { player_id } = req.body;
    try {
        const gameExists = await pool.query('SELECT is_started FROM games WHERE game_id = $1', [game_id]);
        if (gameExists.rows.length === 0 || gameExists.rows[0].is_started) {
            return res.status(404).json({ error: 'Spel niet gevonden of is al gestart.' });
        }
        await pool.query('INSERT INTO game_players (game_id, player_id) VALUES ($1, $2)', [game_id, player_id]);
        res.status(201).json({ message: 'Speler toegevoegd aan spel.' });
    } catch (err) {
        console.error('Fout bij het toevoegen van speler:', err);
        res.status(500).json({ error: 'Fout bij het toevoegen van speler. Controleer de server.' });
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
        
        const playersResult = await pool.query('SELECT player_id FROM game_players WHERE game_id = $1', [game_id]);
        const players = playersResult.rows.map(row => row.player_id);
        const playerCount = players.length;
        // Correctie: check op minimaal 3 spelers
        if (playerCount < 3) {
            return res.status(400).json({ error: 'Niet genoeg spelers om te starten. Minimaal 3 spelers nodig.' });
        }

        const maxRounds = Math.floor(52 / playerCount);
        const newDeck = new Deck();
        newDeck.shuffle();
        
        const game_state = {
            players,
            currentRound: 1, // Start bij ronde 1
            roundDirection: 1,
            trumpCard: newDeck.deal(1)[0],
            bids: {},
            tricksTaken: {},
            scores: {},
            hands: {},
            trick: [],
            currentTurnIndex: 0,
            trickLeaderIndex: 0,
            isBiddingPhase: true
        };

        const numCardsToDeal = game_state.currentRound;
        for (const player of players) {
            game_state.scores[player] = 0;
            game_state.tricksTaken[player] = 0;
            game_state.hands[player] = newDeck.deal(numCardsToDeal);
        }

        await pool.query('UPDATE games SET is_started = true, game_state = $1 WHERE game_id = $2', [JSON.stringify(game_state), game_id]);
        
        res.json({ message: 'Spel gestart!', game_state });
    } catch (err) {
        console.error('Fout bij het starten van het spel:', err);
        res.status(500).json({ error: 'Fout bij het starten van het spel. Controleer de server.' });
    }
});

// GET-route om de spelstatus op te halen
app.get('/games/:game_id/status', async (req, res) => {
    const { game_id } = req.params;
    try {
        const result = await pool.query('SELECT is_started, game_state FROM games WHERE game_id = $1', [game_id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Spel niet gevonden.' });
        }
        res.json({
            is_started: result.rows[0].is_started,
            game_state: result.rows[0].game_state
        });
    } catch (err) {
        console.error('Fout bij het ophalen van de spelstatus:', err);
        res.status(500).json({ error: 'Fout bij het ophalen van de spelstatus.' });
    }
});

// POST-route om een bod in te dienen
app.post('/games/:game_id/bid', async (req, res) => {
    const { game_id } = req.params;
    const { player_id, bid } = req.body;
    try {
        const game = await pool.query('SELECT game_state FROM games WHERE game_id = $1', [game_id]);
        if (game.rows.length === 0 || !game.rows[0].game_state.isBiddingPhase) {
            return res.status(400).json({ error: 'Spel niet gevonden of het is geen biedfase.' });
        }

        let state = game.rows[0].game_state;
        const totalBids = Object.values(state.bids).reduce((sum, current) => sum + current, 0);
        const maxRounds = Math.floor(52 / state.players.length);
        const lastPlayerIndex = state.players.length - 1;

        const playerIndex = state.players.indexOf(player_id);
        if (playerIndex !== state.currentTurnIndex) {
            return res.status(403).json({ error: 'Het is niet jouw beurt om te bieden.' });
        }

        if (playerIndex === lastPlayerIndex && (totalBids + bid) === state.currentRound) {
            return res.status(400).json({ error: 'De laatste speler kan niet een bod doen dat gelijk is aan het ronde nummer.' });
        }

        state.bids[player_id] = bid;
        state.currentTurnIndex = (state.currentTurnIndex + 1) % state.players.length;

        if (Object.keys(state.bids).length === state.players.length) {
            state.isBiddingPhase = false;
            state.currentTurnIndex = state.trickLeaderIndex;
        }

        await pool.query('UPDATE games SET game_state = $1 WHERE game_id = $2', [JSON.stringify(state), game_id]);
        res.json({ message: 'Bod geaccepteerd.', game_state: state });
    } catch (err) {
        console.error('Fout bij het verwerken van bod:', err);
        res.status(500).json({ error: 'Fout bij het verwerken van bod.' });
    }
});

// POST-route om een kaart te spelen
app.post('/games/:game_id/play', async (req, res) => {
    const { game_id } = req.params;
    const { player_id, card } = req.body;
    try {
        const game = await pool.query('SELECT game_state FROM games WHERE game_id = $1', [game_id]);
        if (game.rows.length === 0 || game.rows[0].game_state.isBiddingPhase) {
            return res.status(400).json({ error: 'Spel niet gevonden of het is geen speelfase.' });
        }
        
        let state = game.rows[0].game_state;
        const playerIndex = state.players.indexOf(player_id);

        if (playerIndex !== state.currentTurnIndex) {
            return res.status(403).json({ error: 'Het is niet jouw beurt om een kaart te spelen.' });
        }

        const playerHand = state.hands[player_id];
        const cardIndex = playerHand.findIndex(c => c.rank === card.rank && c.suit === card.suit);
        if (cardIndex === -1) {
            return res.status(400).json({ error: 'Kaart niet in je hand.' });
        }
        
        playerHand.splice(cardIndex, 1);
        state.hands[player_id] = playerHand;

        state.trick.push({ player: player_id, card });

        state.currentTurnIndex = (state.currentTurnIndex + 1) % state.players.length;

        if (state.trick.length === state.players.length) {
            let winningCard = state.trick[0].card;
            let winner = state.trick[0].player;
            let leadSuit = winningCard.suit;

            for (let i = 1; i < state.trick.length; i++) {
                const currentCard = state.trick[i].card;
                const currentCardValue = getCardValue(currentCard);

                if (currentCard.suit === state.trumpCard.suit && winningCard.suit !== state.trumpCard.suit) {
                    winningCard = currentCard;
                    winner = state.trick[i].player;
                } else if (currentCard.suit === leadSuit && currentCardValue > getCardValue(winningCard)) {
                    winningCard = currentCard;
                    winner = state.trick[i].player;
                }
            }

            state.tricksTaken[winner] = (state.tricksTaken[winner] || 0) + 1;
            state.trick = [];
            state.trickLeaderIndex = state.players.indexOf(winner);

            if (playerHand.length === 0) {
                state.players.forEach(p => {
                    const bid = state.bids[p];
                    const tricksWon = state.tricksTaken[p] || 0;
                    let scoreChange = 0;
                    if (bid === tricksWon) {
                        scoreChange = 10 + (2 * tricksWon);
                    } else {
                        scoreChange = (bid - tricksWon) * -2;
                    }
                    state.scores[p] = (state.scores[p] || 0) + scoreChange;
                });
                
                const maxRounds = Math.floor(52 / state.players.length);
                if (state.currentRound === maxRounds) {
                    state.roundDirection = -1;
                } else if (state.currentRound === 1 && state.roundDirection === -1) {
                    state.roundDirection = 1;
                }
                state.currentRound += state.roundDirection;

                const newDeck = new Deck();
                newDeck.shuffle();
                state.trumpCard = newDeck.deal(1)[0];
                const numCardsToDeal = state.currentRound;
                state.hands = {};
                for (const player of state.players) {
                    state.hands[player] = newDeck.deal(numCardsToDeal);
                }

                state.bids = {};
                state.tricksTaken = {};
                state.isBiddingPhase = true;
                state.currentTurnIndex = state.trickLeaderIndex;
            }
        }

        await pool.query('UPDATE games SET game_state = $1 WHERE game_id = $2', [JSON.stringify(state), game_id]);
        res.json({ message: 'Kaart gespeeld.', game_state: state });
    } catch (err) {
        console.error('Fout bij het spelen van de kaart:', err);
        res.status(500).json({ error: 'Fout bij het spelen van de kaart.' });
    }
});

app.listen(port, () => {
    console.log(`Server luistert op poort ${port}`);
});

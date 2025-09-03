// Laad de benodigde modules
const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const app = express();
const port = 3000;

// Middleware om JSON-verzoeken te verwerken
app.use(express.json());
app.use(express.static('public'));

// Configuratie van de Neon-database
const pool = new Pool({
    connectionString: process.env.DATABASE_URL, // Zorg ervoor dat deze omgevingsvariabele is ingesteld
    ssl: {
        rejectUnauthorized: false
    }
});

// Een eenvoudige check om te zien of de database is verbonden
pool.on('connect', () => {
    console.log('Verbonden met de Neon database!');
});

// Initialiseer de database (maak de 'games' tabel aan indien deze nog niet bestaat)
async function initDb() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS games (
                game_id VARCHAR(255) PRIMARY KEY,
                game_state JSONB
            );
        `);
        console.log('Database geïnitialiseerd. "games" tabel is klaar.');
    } catch (err) {
        console.error('Fout bij het initialiseren van de database:', err);
    }
}

// Functie om het spel te initialiseren
function createInitialGameState(gameId, playerName, playerId) {
    return {
        gameId,
        status: 'lobby',
        players: [{ playerId, name: playerName, score: 0 }],
        hostId: playerId,
        round: 0,
        round_sequence: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
        round_index: 0,
        trump_card: null,
        hands: {},
        trick_cards: [],
        tricks_won: {},
        round_bets: {},
        current_player: null,
        lastTrickWinner: null
    };
}

// ---- API-endpoints voor de game ----

// Endpoint om een nieuw spel te maken
app.post('/api/create-game', async (req, res) => {
    const { playerName, playerId } = req.body;
    if (!playerName || !playerId) {
        return res.status(400).send('Spelersnaam en ID zijn vereist.');
    }
    const gameId = crypto.randomUUID().substring(0, 8);
    const gameState = createInitialGameState(gameId, playerName, playerId);

    try {
        await pool.query('INSERT INTO games (game_id, game_state) VALUES ($1, $2)', [gameId, gameState]);
        res.status(201).json({ gameId, gameState });
    } catch (err) {
        console.error('Fout bij het maken van een nieuw spel:', err);
        res.status(500).send('Fout bij het maken van het spel.');
    }
});

// Endpoint om je bij een bestaand spel aan te sluiten
app.post('/api/join-game', async (req, res) => {
    const { gameId, playerName, playerId } = req.body;
    if (!gameId || !playerName || !playerId) {
        return res.status(400).send('Spel-ID, spelersnaam en ID zijn vereist.');
    }

    try {
        const result = await pool.query('SELECT game_state FROM games WHERE game_id = $1', [gameId]);
        if (result.rows.length === 0) {
            return res.status(404).send('Spel niet gevonden.');
        }

        const gameState = result.rows[0].game_state;
        if (gameState.status !== 'lobby') {
            return res.status(400).send('Spel is al begonnen.');
        }

        const playerExists = gameState.players.some(p => p.playerId === playerId);
        if (!playerExists) {
            gameState.players.push({ playerId, name: playerName, score: 0 });
            await pool.query('UPDATE games SET game_state = $1 WHERE game_id = $2', [gameState, gameId]);
        }
        
        res.status(200).json(gameState);
    } catch (err) {
        console.error('Fout bij het aansluiten bij een spel:', err);
        res.status(500).send('Fout bij het aansluiten bij een spel.');
    }
});

// Endpoint om de huidige spelstatus op te halen (polling)
app.get('/api/game/:gameId', async (req, res) => {
    const { gameId } = req.params;
    try {
        const result = await pool.query('SELECT game_state FROM games WHERE game_id = $1', [gameId]);
        if (result.rows.length === 0) {
            return res.status(404).send('Spel niet gevonden.');
        }
        res.status(200).json(result.rows[0].game_state);
    } catch (err) {
        console.error('Fout bij het ophalen van de spelstatus:', err);
        res.status(500).send('Fout bij het ophalen van de spelstatus.');
    }
});

// Endpoint om een actie in het spel uit te voeren
app.post('/api/action', async (req, res) => {
    const { gameId, action, payload } = req.body;
    if (!gameId || !action || !payload) {
        return res.status(400).send('Ongeldige actie of payload.');
    }
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await client.query('SELECT game_state FROM games WHERE game_id = $1 FOR UPDATE', [gameId]);
        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).send('Spel niet gevonden.');
        }

        let gameState = result.rows[0].game_state;
        
        // Verwerk de actie op basis van het type
        switch(action) {
            case 'startGame':
                if (gameState.hostId !== payload.playerId) {
                    throw new Error('Alleen de host kan het spel starten.');
                }
                const deck = createDeck();
                shuffleDeck(deck);
                const numCards = gameState.round_sequence[gameState.round_index];
                const hands = {};
                for (const player of gameState.players) {
                    hands[player.playerId] = deck.splice(0, numCards);
                }
                const trumpCard = deck.splice(0, 1)[0];
                const tricksWon = {};
                const roundBets = {};
                gameState.players.forEach(p => {
                    tricksWon[p.playerId] = 0;
                    roundBets[p.playerId] = null;
                });
                
                gameState.status = 'playing';
                gameState.hands = hands;
                gameState.trump_card = trumpCard;
                gameState.tricks_won = tricksWon;
                gameState.round_bets = roundBets;
                gameState.current_player = gameState.players[0].playerId;
                gameState.trick_cards = [];
                break;
            case 'placeBet':
                if (gameState.current_player !== payload.playerId) {
                    throw new Error('Niet jouw beurt om te gokken.');
                }
                gameState.round_bets[payload.playerId] = payload.bet;
                
                // Bepaal de volgende speler om te gokken
                const currentBettingIndex = gameState.players.findIndex(p => p.playerId === payload.playerId);
                const nextBettingIndex = (currentBettingIndex + 1) % gameState.players.length;
                gameState.current_player = gameState.players[nextBettingIndex].playerId;
                
                // Als alle spelers hebben gegokt, reset dan de 'current_player' voor de eerste slag
                const allPlayersBet = Object.values(gameState.round_bets).every(bet => bet !== null);
                if (allPlayersBet) {
                    gameState.current_player = gameState.players[0].playerId;
                }
                break;
            case 'playCard':
                if (gameState.current_player !== payload.playerId) {
                    throw new Error('Niet jouw beurt om een kaart te spelen.');
                }
                
                const myHand = gameState.hands[payload.playerId];
                const cardIndex = myHand.findIndex(c => c.suit === payload.card.suit && c.rank === payload.card.rank);
                if (cardIndex === -1) {
                    throw new Error('Kaart niet in hand.');
                }
                
                const trickCards = gameState.trick_cards;
                const leadCard = trickCards.length > 0 ? trickCards[0].card : null;
                const hasLeadSuit = myHand.some(c => c.suit === (leadCard ? leadCard.suit : null));

                if (leadCard && hasLeadSuit && payload.card.suit !== leadCard.suit) {
                    throw new Error("Je moet de juiste soort kaart volgen.");
                }

                myHand.splice(cardIndex, 1);
                trickCards.push({ card: payload.card, playerName: payload.playerName, playerId: payload.playerId });

                // Bepaal de volgende speler
                const currentPlayerIndex = gameState.players.findIndex(p => p.playerId === payload.playerId);
                const nextPlayerIndex = (currentPlayerIndex + 1) % gameState.players.length;
                gameState.current_player = gameState.players[nextPlayerIndex].playerId;

                // Als de slag vol is, verwerk de slag
                if (trickCards.length === gameState.players.length) {
                    await processTrick(gameState);
                }
                break;
            default:
                throw new Error('Onbekende actie.');
        }

        await client.query('UPDATE games SET game_state = $1 WHERE game_id = $2', [gameState, gameId]);
        await client.query('COMMIT');
        res.status(200).json(gameState);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Fout bij het verwerken van de actie:', err.message);
        res.status(400).send(err.message);
    } finally {
        client.release();
    }
});

// Functie om de winnaar van een slag te bepalen en de score bij te werken
async function processTrick(gameState) {
    const trickCards = gameState.trick_cards;
    const trumpSuit = gameState.trump_card.suit;
    const leadSuit = trickCards[0].card.suit;
    const rankOrder = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'].reduce((obj, r, i) => ({ ...obj, [r]: i }), {});

    let winningCard = trickCards[0];
    for (let i = 1; i < trickCards.length; i++) {
        const currentCard = trickCards[i];
        if (currentCard.card.suit === trumpSuit && winningCard.card.suit !== trumpSuit) {
            winningCard = currentCard;
        } else if (currentCard.card.suit === trumpSuit && winningCard.card.suit === trumpSuit) {
            if (rankOrder[currentCard.card.rank] > rankOrder[winningCard.card.rank]) {
                winningCard = currentCard;
            }
        } else if (currentCard.card.suit === leadSuit && winningCard.card.suit === leadSuit) {
            if (rankOrder[currentCard.card.rank] > rankOrder[winningCard.card.rank]) {
                winningCard = currentCard;
            }
        }
    }
    
    gameState.tricks_won[winningCard.playerId]++;
    gameState.current_player = winningCard.playerId;
    gameState.trick_cards = [];

    // Controleer of de ronde is afgelopen
    const allHandsEmpty = Object.values(gameState.hands).every(hand => hand.length === 0);
    if (allHandsEmpty) {
        processEndRound(gameState);
    }
}

// Functie om een ronde te beëindigen
function processEndRound(gameState) {
    gameState.players.forEach(p => {
        const bet = gameState.round_bets[p.playerId];
        const tricks = gameState.tricks_won[p.playerId];
        if (bet === tricks) {
            p.score += 10 + (bet * 5);
        }
    });

    const nextRoundIndex = gameState.round_index + 1;
    if (nextRoundIndex >= gameState.round_sequence.length) {
        gameState.status = 'ended';
    } else {
        gameState.round++;
        gameState.round_index = nextRoundIndex;
        // Start de nieuwe ronde logica, gelijk aan de startGame-logica
        const deck = createDeck();
        shuffleDeck(deck);
        const numCards = gameState.round_sequence[nextRoundIndex];
        const hands = {};
        for (const player of gameState.players) {
            hands[player.playerId] = deck.splice(0, numCards);
        }
        const trumpCard = deck.splice(0, 1)[0];
        const tricksWon = {};
        const roundBets = {};
        gameState.players.forEach(p => {
            tricksWon[p.playerId] = 0;
            roundBets[p.playerId] = null;
        });

        gameState.hands = hands;
        gameState.trump_card = trumpCard;
        gameState.tricks_won = tricksWon;
        gameState.round_bets = roundBets;
        gameState.current_player = gameState.players[0].playerId;
    }
}

function createDeck() {
    const suits = ['harten', 'ruiten', 'klaveren', 'schoppen'];
    const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    const deck = [];
    for (const suit of suits) {
        for (const rank of ranks) {
            deck.push({ suit, rank });
        }
    }
    return deck;
}

function shuffleDeck(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

// Start de server
app.listen(port, () => {
    console.log(`Server draait op http://localhost:${port}`);
    initDb();
});

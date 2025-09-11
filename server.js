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
        
        await client.query('INSERT INTO games (game_id, player_host, current_turn) VALUES ($1, $2, $3)', [game_id, player_host, player_host]);
        await client.query('INSERT INTO game_players (game_id, player_id) VALUES ($1, $2)', [game_id, player_host]);

        const deckResult = await client.query('INSERT INTO decks (game_id) VALUES ($1) RETURNING deck_id', [game_id]);
        const deck_id = deckResult.rows[0].deck_id;

        const suits = ['h', 'd', 'c', 's'];
        const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'j', 'q', 'k', 'a'];
        const cards = [];
        for (const suit of suits) {
            for (const value of values) {
                cards.push(value + suit);
            }
        }
        // Voeg Jokers toe
        cards.push('jo1', 'jo2');

        for (let i = 0; i < cards.length; i++) {
            await client.query('INSERT INTO deck_cards (deck_id, card_value, card_order) VALUES ($1, $2, $3)', [deck_id, cards[i], i]);
        }
        
        await client.query('COMMIT');
        res.status(201).json({ message: 'Game aangemaakt', gameId: game_id });

    } catch (error) {
        if (client) {
            await client.query('ROLLBACK');
        }
        console.error('Fout bij het aanmaken van game:', error);
        res.status(500).json({ error: 'Fout bij het aanmaken van game.' });
    } finally {
        if (client) {
            client.release();
        }
    }
});

// POST-route om een speler aan een game toe te voegen
app.post('/games/:game_id/players', async (req, res) => {
    const { game_id } = req.params;
    const { player_id } = req.body;
    try {
        const result = await pool.query('INSERT INTO game_players (game_id, player_id) VALUES ($1, $2) ON CONFLICT (game_id, player_id) DO NOTHING', [game_id, player_id]);
        if (result.rowCount === 0) {
            res.status(200).json({ message: 'Speler bestaat al.' });
        } else {
            res.status(201).json({ message: 'Speler toegevoegd.' });
        }
    } catch (error) {
        console.error('Fout bij het toevoegen van speler:', error);
        res.status(500).json({ error: 'Fout bij het toevoegen van speler.' });
    }
});

// GET-route om de spelers van een game op te halen
app.get('/games/:game_id/players', async (req, res) => {
    const { game_id } = req.params;
    try {
        const result = await pool.query('SELECT player_id FROM game_players WHERE game_id = $1 ORDER BY player_join_date', [game_id]);
        res.json(result.rows);
    } catch (err) {
        console.error('Fout bij het ophalen van spelers:', err);
        res.status(500).json({ error: 'Fout bij het ophalen van spelers. Controleer de server.' });
    }
});

// GET-route om de hand van een speler op te halen
app.get('/games/:game_id/players/:player_id/hand', async (req, res) => {
    const { game_id, player_id } = req.params;
    try {
        const result = await pool.query('SELECT card_value FROM player_cards WHERE game_id = $1 AND player_id = $2', [game_id, player_id]);
        res.json({ cards: result.rows.map(row => row.card_value) });
    } catch (err) {
        console.error('Fout bij het ophalen van de hand:', err);
        res.status(500).json({ error: 'Fout bij het ophalen van de hand.' });
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
        
        const playersResult = await pool.query('SELECT player_id FROM game_players WHERE game_id = $1 ORDER BY player_join_date', [game_id]);
        const players = playersResult.rows.map(row => row.player_id);
        const playerCount = players.length;
        if (playerCount < 3 || playerCount > 7) {
            return res.status(400).json({ error: 'Ongeldig aantal spelers. Minimaal 3, maximaal 7.' });
        }

        // Bepaal het aantal rondes
        const totalRounds = 52 / playerCount;

        // Bepaal de ronde-reeks (1 tot max en terug)
        const roundSequence = [];
        for (let i = 1; i <= totalRounds; i++) {
            roundSequence.push(i);
        }
        for (let i = totalRounds - 1; i >= 1; i--) {
            roundSequence.push(i);
        }
        
        await pool.query('UPDATE games SET is_started = true, current_round = 1, round_sequence = $1 WHERE game_id = $2', [JSON.stringify(roundSequence), game_id]);
        
        // Start de eerste ronde
        await startNewRound(game_id, players, 1);
        
        res.json({ message: 'Spel gestart', firstCard: null }); // De eerste kaart wordt nu in de ronde gezet, niet hier.

    } catch (error) {
        console.error('Fout bij het starten van game:', error);
        res.status(500).json({ error: 'Fout bij het starten van game.' });
    }
});

// Functie om een nieuwe ronde te starten
async function startNewRound(game_id, players, roundNumber) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // Schud de aflegstapel en maak een nieuwe trekstapel
        await client.query(`
            INSERT INTO deck_cards (deck_id, card_value, card_order)
            SELECT deck_id, card_value, (random() * 10000)::integer
            FROM discard_pile
            WHERE game_id = $1
            ON CONFLICT (deck_id, card_value) DO NOTHING;
        `, [game_id]);
        await client.query('DELETE FROM discard_pile WHERE game_id = $1', [game_id]);

        // Verwijder kaarten uit de handen van spelers en hun gokken
        await client.query('DELETE FROM player_cards WHERE game_id = $1', [game_id]);
        await client.query('DELETE FROM player_bets WHERE game_id = $1', [game_id]);

        // Deel kaarten uit voor de nieuwe ronde
        for (const player of players) {
            for (let i = 0; i < roundNumber; i++) {
                await client.query(`
                    WITH drawn AS (
                        DELETE FROM deck_cards
                        WHERE deck_id = (SELECT deck_id FROM decks WHERE game_id = $1)
                        AND card_order = (SELECT MIN(card_order) FROM deck_cards WHERE deck_id = (SELECT deck_id FROM decks WHERE game_id = $1))
                        RETURNING card_value
                    )
                    INSERT INTO player_cards (game_id, player_id, card_value)
                    SELECT $1, $2, drawn.card_value
                    FROM drawn;
                `, [game_id, player]);
            }
        }
        
        // Bepaal een nieuwe troefkaart
        const trumpCardResult = await client.query(`
            WITH drawn AS (
                DELETE FROM deck_cards
                WHERE deck_id = (SELECT deck_id FROM decks WHERE game_id = $1)
                AND card_order = (SELECT MIN(card_order) FROM deck_cards WHERE deck_id = (SELECT deck_id FROM decks WHERE game_id = $1))
                RETURNING card_value
            )
            SELECT card_value FROM drawn;
        `, [game_id]);
        const trumpCard = trumpCardResult.rows[0].card_value;
        
        await client.query('UPDATE games SET current_round = $1, trump_card = $2, current_turn = $3 WHERE game_id = $4', [roundNumber, trumpCard, players[0], game_id]);
        
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Fout bij het starten van nieuwe ronde:', error);
    } finally {
        client.release();
    }
}

// GET-route om de gamestatus op te halen
app.get('/games/:game_id/status', async (req, res) => {
    const { game_id } = req.params;
    try {
        const gameStatusResult = await pool.query('SELECT * FROM games WHERE game_id = $1', [game_id]);
        const game = gameStatusResult.rows[0];

        if (!game) {
            return res.status(404).json({ error: 'Game niet gevonden.' });
        }

        const playersResult = await pool.query('SELECT player_id FROM game_players WHERE game_id = $1 ORDER BY player_join_date', [game_id]);
        const players = playersResult.rows.map(row => row.player_id);

        res.json({
            isStarted: game.is_started,
            currentRound: game.current_round,
            trumpCard: game.trump_card,
            currentTurn: game.current_turn,
            players: players,
            winnerId: game.winner_id,
            totalRounds: game.round_sequence ? JSON.parse(game.round_sequence).length : 0,
            roundNumber: game.current_round
        });

    } catch (error) {
        console.error('Fout bij het ophalen van gamestatus:', error);
        res.status(500).json({ error: 'Fout bij het ophalen van gamestatus.' });
    }
});


// POST-route om een gok te plaatsen
app.post('/games/:game_id/bet', async (req, res) => {
    const { game_id } = req.params;
    const { player_id, bet_amount } = req.body;
    try {
        const client = await pool.connect();
        await client.query('BEGIN');
        
        const turnCheck = await client.query('SELECT current_turn, current_round FROM games WHERE game_id = $1', [game_id]);
        if (turnCheck.rows.length === 0 || turnCheck.rows[0].current_turn !== player_id) {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: 'Het is niet jouw beurt.' });
        }
        
        const currentRound = turnCheck.rows[0].current_round;
        if (bet_amount > currentRound || bet_amount < 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: `Ongeldige gok. De gok moet tussen 0 en ${currentRound} liggen.` });
        }
        
        await client.query('INSERT INTO player_bets (game_id, player_id, bet_amount) VALUES ($1, $2, $3)', [game_id, player_id, bet_amount]);

        const playersResult = await client.query('SELECT player_id FROM game_players WHERE game_id = $1 ORDER BY player_join_date', [game_id]);
        const players = playersResult.rows.map(row => row.player_id);
        const currentPlayerIndex = players.indexOf(player_id);
        const nextPlayer = players[(currentPlayerIndex + 1) % players.length];

        await client.query('UPDATE games SET current_turn = $1 WHERE game_id = $2', [nextPlayer, game_id]);
        
        // Controleer of iedereen gegokt heeft
        const betsCountResult = await client.query('SELECT COUNT(*) FROM player_bets WHERE game_id = $1', [game_id]);
        if (parseInt(betsCountResult.rows[0].count, 10) === players.length) {
             // Begin de ronde (in een latere implementatie)
             console.log("Gokfase afgerond. Start de ronde.");
        }

        await client.query('COMMIT');
        res.status(200).json({ message: 'Gok geplaatst.', nextTurn: nextPlayer });

    } catch (error) {
        if (client) {
            await client.query('ROLLBACK');
        }
        console.error('Fout bij het plaatsen van gok:', error);
        res.status(500).json({ error: 'Fout bij het plaatsen van gok.' });
    } finally {
        if (client) {
            client.release();
        }
    }
});


app.listen(port, () => {
    console.log(`Server draait op http://localhost:${port}`);
});

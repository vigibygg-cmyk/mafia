io.on('connection', (socket) => {
    socket.on('join_game', (playerName) => {
        if (gameState.phase !== 'LOBBY') {
            socket.emit('error_message', 'Žaidimas jau prasidėjęs.');
            return;
        }
        
        gameState.players[socket.id] = {
            id: socket.id,
            name: playerName,
            role: null,
            isAlive: true
        };
        io.emit('update_players', Object.values(gameState.players));
    });

    // Žaidimo paleidimo signalas iš kliento
    socket.on('start_game', () => {
        const playerIds = Object.keys(gameState.players);
        
        // Griežtas apribojimas pagal ankstesnį susitarimą
        if (playerIds.length < 6) {
            socket.emit('error_message', 'Žaidimą galima pradėti tik turint bent 6 žaidėjus.');
            return;
        }

        if (gameState.phase !== 'LOBBY') return;

        // Būsenos keitimas
        gameState.phase = 'NIGHT';
        
        // Žaidėjų sąrašo sumaišymas (Fisher-Yates algoritmas)
        for (let i = playerIds.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [playerIds[i], playerIds[j]] = [playerIds[j], playerIds[i]];
        }

        // Vaidmenų paskirstymas (1 Mafija (arba 2, jei 8+ žaidėjai), 1 Detektyvas, 1 Daktaras, kiti Miestiečiai)
        let mafiaCount = playerIds.length >= 8 ? 2 : 1;
        let assigned = 0;
        
        for(let i=0; i<mafiaCount; i++) gameState.players[playerIds[assigned++]].role = 'MAFIJA';
        gameState.players[playerIds[assigned++]].role = 'DETEKTYVAS';
        gameState.players[playerIds[assigned++]].role = 'DAKTARAS';
        
        while(assigned < playerIds.length) {
            gameState.players[playerIds[assigned++]].role = 'MIESTIETIS';
        }

        // Kiekvienam žaidėjui asmeniškai išsiunčiamas tik jo vaidmuo, kad kiti nematytų
        playerIds.forEach(id => {
            const playerRole = gameState.players[id].role;
            io.to(id).emit('game_started', playerRole);
        });
    });

    socket.on('disconnect', () => {
        if (gameState.players[socket.id]) {
            delete gameState.players[socket.id];
            // Jei atjungiama LOBBY fazėje - atnaujinam sąrašą.
            // Jei žaidimo metu - tolesnė logika (bus rašoma vėliau).
            if (gameState.phase === 'LOBBY') {
                io.emit('update_players', Object.values(gameState.players));
            }
        }
    });
});

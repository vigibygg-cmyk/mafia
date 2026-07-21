const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// CORS nustatymas būtinas, kad tavo GitHub Pages front-end galėtų susijungti su Render serveriu
const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

io.on('connection', (socket) => {
    console.log('Naujas klientas prisijungė, ID:', socket.id);

    socket.on('disconnect', () => {
        console.log('Klientas atsijungė, ID:', socket.id);
    });
});

// Render automatiškai priskiria PORT aplinkos kintamąjį. Būtina jį naudoti.
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Serveris sėkmingai pasileido ant prievado ${PORT}`);
});

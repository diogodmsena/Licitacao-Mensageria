const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(express.json()); // Permite que o servidor entenda o JSON enviado pelo Maker
app.use(cors()); // Configuração básica de CORS

const server = http.createServer(app);

// Inicializa o Socket.IO com configurações de resiliência
const io = new Server(server, {
    cors: {
        origin: "*", // Em produção, restrinja para o domínio/IP do seu Webrun
        methods: ["GET", "POST"]
    },
    pingTimeout: 60000, // Tempo máximo sem resposta do cliente (reaper automático)
    pingInterval: 25000 // Frequência do heartbeat do servidor para o cliente
});

// 1. Gerenciamento das conexões dos Clientes (Navegadores)
io.on('connection', (socket) => {
    console.log(`[+] Cliente conectado: ${socket.id}`);

    // Quando o cliente pede para entrar no pregão
    socket.on('entrar_sala', (salaReq) => {
        // Força o valor a ser interpretado como Texto (String)
        const sala = String(salaReq);
        socket.join(sala);

        // Guardamos o nome da sala "dentro" do socket deste cliente 
        // para sabermos de onde ele saiu quando a conexão cair
        socket.sala_atual = sala;

        // console.log(`[>] Cliente ${socket.id} entrou na sala: ${sala}`);
        console.log(`[>] Cliente ${socket.id} entrou na sala: '${sala}'`);

        // Conta quantos usuários tem na sala agora e avisa a sala inteira
        const qtdUsuarios = io.sockets.adapter.rooms.get(sala).size;
        io.to(sala).emit('atualizacao_qtd_usuarios', { quantidade: qtdUsuarios });
    });

    // Quando o cliente fecha a aba, perde a internet ou atualiza a página (F5)
    socket.on('disconnect', () => {
        console.log(`[-] Cliente desconectado: ${socket.id}`);

        if (socket.sala_atual) {
            // Pega a sala. Se ele for o último a sair, o room será undefined, então a qtd é 0.
            const room = io.sockets.adapter.rooms.get(socket.sala_atual);
            const qtdUsuarios = room ? room.size : 0;

            // Avisa quem ficou na sala sobre a nova quantidade
            io.to(socket.sala_atual).emit('atualizacao_qtd_usuarios', { quantidade: qtdUsuarios });
        }
    });
});

// 2. Endpoint REST para o Softwell Maker disparar as mensagens
app.post('/api/enviar-mensagem', (req, res) => {
    const { sala, evento, payload } = req.body;

    if (!evento || !payload) {
        return res.status(400).json({ erro: "Os campos 'evento' e 'payload' são obrigatórios." });
    }

    // Se uma sala foi especificada, envia apenas para ela. Caso contrário, faz broadcast global.
    if (sala) {
        io.to(sala).emit(evento, payload);
    } else {
        io.emit(evento, payload);
    }

    console.log(`[API] Mensagem despachada -> Evento: '${evento}', Sala: '${sala || 'Global'}'`);
    res.status(200).json({ sucesso: true, mensagem: "Despacho realizado." });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor Socket.IO rodando na porta ${PORT}`);
});
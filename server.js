require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');

const app = express();
app.use(helmet()); // Proteção com cabeçalhos de segurança HTTP
app.use(express.json()); // Permite que o servidor entenda o JSON enviado pelo Maker
app.use(cors({
    origin: process.env.CORS_ORIGIN || "*"
})); // Configuração de CORS restrita por variável de ambiente

// Rota de Health Check (Página Inicial)
app.get('/', (req, res) => {
    res.status(200).send(`
        <html>
            <body style="font-family: Arial, sans-serif; text-align: center; margin-top: 50px;">
                <h2 style="color: #2e7d32;">✅ Servidor de Mensageria Ativo</h2>
                <p>O serviço Socket.IO do Pregão Eletrônico está rodando perfeitamente.</p>
            </body>
        </html>
    `);
});

const server = http.createServer(app);

// Inicializa o Socket.IO com configurações de resiliência
const io = new Server(server, {
    cors: {
        origin: process.env.CORS_ORIGIN || "*", // Restringe a origem baseada na variável de ambiente
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
    // Autenticação de segurança via API Key
    const apiKey = req.headers['x-api-key'];
    if (process.env.API_KEY && apiKey !== process.env.API_KEY) {
        return res.status(401).json({ erro: "Não autorizado. Chave de API inválida." });
    }

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
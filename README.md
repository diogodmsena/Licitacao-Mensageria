# Licitação Mensageria

Este é um servidor de mensageria em tempo real baseado em **Node.js**, **Express** e **Socket.IO**. Foi projetado para gerenciar salas de chat ou pregões de licitação, permitindo que clientes (navegadores) se conectem e recebam atualizações via WebSockets, enquanto sistemas externos (como o Softwell Maker) disparem eventos através de uma API REST.

## 📋 Funcionalidades

- **Conexão WebSocket**: Clientes podem se conectar e interagir em tempo real via Socket.IO.
- **Gestão de Salas**: Clientes podem entrar em salas específicas (ex: um pregão específico) e o servidor gerencia a quantidade de usuários logados em cada sala (`atualizacao_qtd_usuarios`).
- **Desconexão Resiliente**: Se um cliente fecha o navegador ou perde conexão, a sala é notificada sobre a nova contagem de usuários.
- **API REST para Broadcast**: Um endpoint POST `/api/enviar-mensagem` que permite que sistemas externos enviem mensagens para uma sala específica ou de forma global para todos conectados.

## 🚀 Tecnologias Utilizadas

- **Node.js**
- **Express.js** (Roteamento e Servidor HTTP)
- **Socket.IO** (Comunicação em tempo real WebSockets)
- **CORS** (Controle de acesso HTTP/WebSocket)

## 📦 Instalação

1. Clone ou faça o download deste diretório.
2. Acesse a pasta do projeto no terminal (`c:\dev\Licitacao-Mensageria`).
3. Instale as dependências:
   ```bash
   npm install
   ```

## ⚙️ Configuração e Execução

O servidor utiliza a porta definida pela variável de ambiente `PORT` ou `3000` por padrão.

Para iniciar o servidor, execute:
```bash
npm start
```
*(O comando executará `node server.js`)*

## 🌐 Endpoints da API

### `POST /api/enviar-mensagem`

Recebe uma mensagem (via requisição HTTP) e a distribui (faz *broadcast*) via Socket.IO para os clientes conectados.

- **Corpo da Requisição (JSON):**
  ```json
  {
    "sala": "sala_teste", // (Opcional) Nome da sala de destino. Se omitido, envia para todos os conectados da rede.
    "evento": "atualizacao_dados", // O nome do Evento Socket.IO que os clientes vão escutar.
    "payload": { // Dados que serão transmitidos. Pode ser um objeto, string, array, etc.
       "mensagem": "Nova oferta recebida",
       "valor": 1500.00
    }
  }
  ```

## 📡 Eventos WebSocket (Socket.IO)

### Recebidos pelo Servidor (O que o Front-End envia):
- `entrar_sala` (string): O cliente emite este evento com o nome da sala que deseja ingressar. Ex: `socket.emit('entrar_sala', 'pregao_123');`.

### Emitidos pelo Servidor (O que o Front-End escuta):
- `atualizacao_qtd_usuarios` (objeto): Disparado para a sala avisando a quantidade atual de participantes sempre que alguém entra ou sai.
  ```json
  { "quantidade": 4 }
  ```
- **Eventos Dinâmicos**: O servidor pode emitir qualquer nome de evento definido dinamicamente pelo campo `evento` do payload da API REST `/api/enviar-mensagem`. Ex: `atualizacao_dados`.

---

## ⚠️ Avaliação para Produção (Review de Robustez)

Conforme a análise de prontidão para produção solicitada, o sistema é funcional, porém as seguintes ressalvas devem ser tratadas para garantir maior robustez e segurança antes do *deploy* definitivo em produção:

1. **Segurança do Endpoint REST (`/api/enviar-mensagem`)**
   - **Situação Atual**: Qualquer pessoa na internet com acesso à URL pode fazer uma requisição POST e disparar mensagens para os clientes.
   - **Recomendação**: Implementar um *middleware* de autenticação, como um `API Key` simples (ex: checar `req.headers['x-api-key']`) ou *Token JWT* antes de processar os envios. Isso garantirá que apenas o seu backend (Maker/ERP) realize os disparos.

2. **Configuração de CORS**
   - **Situação Atual**: Express e Socket.IO estão configurados com `origin: "*"`, aceitando conexões de qualquer domínio.
   - **Recomendação**: Limitar as origens (`cors origin`) especificamente para as URLs do seu sistema front-end em produção, a fim de evitar acessos indevidos e ataques de *Cross-Site WebSocket Hijacking*. Pode ser feito lendo uma variável de ambiente (ex: `process.env.CORS_ORIGIN`).

3. **Gerenciamento de Variáveis de Ambiente**
   - **Situação Atual**: As chaves e portas não usam um sistema de `.env`.
   - **Recomendação**: Adicionar um pacote como `dotenv` para centralizar as configurações (como Portas, API Keys e Origens de CORS) em arquivos locais, evitando expor informações sensíveis ou ter de chumbá-las no código (Hardcode).

4. **Cabeçalhos de Segurança HTTP**
   - **Recomendação**: Adicionar a biblioteca `helmet` no Express (`app.use(helmet())`) para proteção contra vulnerabilidades web bloqueando e ajustando certos cabeçalhos HTTP por padrão.

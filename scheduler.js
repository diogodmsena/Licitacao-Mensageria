const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Limite máximo seguro para setTimeout em motores JS (32-bit signed int: ~24.85 dias)
const MAX_TIMEOUT_MS = 2147483647;
// Intervalo de verificação de segurança (a cada 30 segundos)
const HEARTBEAT_INTERVAL_MS = 30000;
// Tempo limite padrão para a requisição HTTP ao Maker (30 segundos)
const DEFAULT_HTTP_TIMEOUT_MS = Number(process.env.MAKER_WEBHOOK_TIMEOUT_MS) || 30000;

class AgendadorMaker {
    constructor(dbPath) {
        const defaultDir = path.join(__dirname, 'data');
        if (!fs.existsSync(defaultDir)) {
            fs.mkdirSync(defaultDir, { recursive: true });
        }

        this.dbPath = dbPath || path.join(defaultDir, 'agendamentos.db');
        this.db = new DatabaseSync(this.dbPath);
        this.proximoTimer = null;
        this.heartbeatTimer = null;
        this.emExecucao = false;

        this._inicializarBanco();
    }

    _inicializarBanco() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS agendamentos (
                id TEXT PRIMARY KEY,
                descricao TEXT,
                data_execucao TEXT NOT NULL,
                timestamp_execucao INTEGER NOT NULL,
                url TEXT NOT NULL,
                metodo TEXT NOT NULL DEFAULT 'POST',
                headers TEXT NOT NULL DEFAULT '{}',
                payload TEXT NOT NULL DEFAULT '{}',
                status TEXT NOT NULL DEFAULT 'PENDENTE',
                tentativas INTEGER NOT NULL DEFAULT 0,
                max_tentativas INTEGER NOT NULL DEFAULT 3,
                ultimo_status_http INTEGER,
                ultima_resposta TEXT,
                executado_em TEXT,
                criado_em TEXT NOT NULL,
                atualizado_em TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_agendamentos_status_timestamp
            ON agendamentos (status, timestamp_execucao);
        `);

        // Se o servidor caiu enquanto algum item estava como PROCESSANDO, volta para PENDENTE
        this.db.exec(`
            UPDATE agendamentos
            SET status = 'PENDENTE', atualizado_em = '${new Date().toISOString()}'
            WHERE status = 'PROCESSANDO';
        `);
    }

    /**
     * Inicia o motor de agendamento e processa pendências vencidas ou futuras.
     */
    iniciar() {
        console.log(`[Agendador] Inicializando motor com banco local: ${this.dbPath}`);
        this._recalcularTimer();

        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
        }
        this.heartbeatTimer = setInterval(() => {
            this._processarVencidos();
        }, HEARTBEAT_INTERVAL_MS);
        this.heartbeatTimer.unref?.();
    }

    /**
     * Encerra os timers ativos (útil para testes e desligamento gracioso).
     */
    parar() {
        if (this.proximoTimer) {
            clearTimeout(this.proximoTimer);
            this.proximoTimer = null;
        }
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    /**
     * Converte e valida uma string de data/hora para timestamp e ISO string.
     * Aceita ISO-8601 ("2026-11-15T14:30:00-03:00") ou formato SQL ("2026-11-15 14:30:00").
     */
    _parseDataExecucao(dataInput) {
        if (!dataInput) {
            throw new Error("O campo 'data_execucao' é obrigatório.");
        }

        let normalizada = String(dataInput).trim();
        // Suporte amigável para formato "YYYY-MM-DD HH:mm:ss" enviado pelo Maker
        if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(:\d{2})?$/.test(normalizada)) {
            normalizada = normalizada.replace(/\s+/, 'T');
        }

        const dateObj = new Date(normalizada);
        const timestamp = dateObj.getTime();

        if (Number.isNaN(timestamp)) {
            throw new Error(`Formato de 'data_execucao' inválido: '${dataInput}'. Use ISO-8601 (ex: 2026-11-15T14:30:00-03:00 ou 2026-11-15 14:30:00).`);
        }

        return {
            iso: dateObj.toISOString(),
            timestamp
        };
    }

    /**
     * Resolve a URL final do Webhook do Maker (permite URL completa ou caminho relativo com MAKER_BASE_URL).
     */
    _resolverUrl(urlInput) {
        if (!urlInput || typeof urlInput !== 'string') {
            throw new Error("O campo 'url' é obrigatório.");
        }

        const urlLimpa = urlInput.trim();
        if (/^https?:\/\//i.test(urlLimpa)) {
            return urlLimpa;
        }

        const baseUrl = process.env.MAKER_BASE_URL;
        if (!baseUrl) {
            throw new Error("A 'url' informada é relativa, mas 'MAKER_BASE_URL' não está configurada no .env. Informe uma URL completa (http://... ou https://...).");
        }

        return new URL(urlLimpa, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
    }

    /**
     * Formata uma linha do SQLite para retorno JSON limpo.
     */
    _formatarRegistro(row) {
        if (!row) return null;
        return {
            ...row,
            headers: this._safeJsonParse(row.headers, {}),
            payload: this._safeJsonParse(row.payload, {})
        };
    }

    _safeJsonParse(str, fallback) {
        try {
            return str ? JSON.parse(str) : fallback;
        } catch {
            return str;
        }
    }

    /**
     * Cria ou reagenda (UPSERT) um agendamento para disparo ao Maker.
     */
    agendar(dados) {
        const id = dados.id ? String(dados.id).trim() : crypto.randomUUID();
        const descricao = dados.descricao ? String(dados.descricao).trim() : null;
        const { iso, timestamp } = this._parseDataExecucao(dados.data_execucao);
        const url = this._resolverUrl(dados.url);
        const metodo = String(dados.metodo || 'POST').toUpperCase();

        if (!['POST', 'GET', 'PUT', 'PATCH'].includes(metodo)) {
            throw new Error(`Método HTTP '${metodo}' não suportado. Use POST, GET, PUT ou PATCH.`);
        }

        const headersJson = JSON.stringify(dados.headers && typeof dados.headers === 'object' ? dados.headers : {});
        const payloadJson = JSON.stringify(dados.payload !== undefined ? dados.payload : {});
        const maxTentativas = Number.isInteger(dados.max_tentativas) && dados.max_tentativas >= 1
            ? dados.max_tentativas
            : 3;

        const agoraIso = new Date().toISOString();

        const stmt = this.db.prepare(`
            INSERT INTO agendamentos (
                id, descricao, data_execucao, timestamp_execucao, url, metodo,
                headers, payload, status, tentativas, max_tentativas,
                ultimo_status_http, ultima_resposta, executado_em, criado_em, atualizado_em
            ) VALUES (
                ?, ?, ?, ?, ?, ?,
                ?, ?, 'PENDENTE', 0, ?,
                NULL, NULL, NULL, ?, ?
            )
            ON CONFLICT(id) DO UPDATE SET
                descricao = COALESCE(excluded.descricao, agendamentos.descricao),
                data_execucao = excluded.data_execucao,
                timestamp_execucao = excluded.timestamp_execucao,
                url = excluded.url,
                metodo = excluded.metodo,
                headers = excluded.headers,
                payload = excluded.payload,
                status = 'PENDENTE',
                tentativas = 0,
                max_tentativas = excluded.max_tentativas,
                ultimo_status_http = NULL,
                ultima_resposta = NULL,
                executado_em = NULL,
                atualizado_em = excluded.atualizado_em
        `);

        stmt.run(
            id,
            descricao,
            iso,
            timestamp,
            url,
            metodo,
            headersJson,
            payloadJson,
            maxTentativas,
            agoraIso,
            agoraIso
        );

        console.log(`[Agendador] Agendamento '${id}' programado para ${iso} -> ${metodo} ${url}`);
        this._recalcularTimer();

        return this.buscarPorId(id);
    }

    /**
     * Atualiza parcialmente um agendamento existente (reagendar horário, trocar payload, etc.).
     */
    atualizar(id, dados) {
        const atual = this.buscarPorId(id);
        if (!atual) {
            return null;
        }

        const novaDataExecucao = dados.data_execucao !== undefined ? dados.data_execucao : atual.data_execucao;
        const { iso, timestamp } = this._parseDataExecucao(novaDataExecucao);
        const novaUrl = dados.url !== undefined ? this._resolverUrl(dados.url) : atual.url;
        const novoMetodo = dados.metodo !== undefined ? String(dados.metodo).toUpperCase() : atual.metodo;
        const novaDescricao = dados.descricao !== undefined ? dados.descricao : atual.descricao;
        const novosHeaders = dados.headers !== undefined ? dados.headers : atual.headers;
        const novoPayload = dados.payload !== undefined ? dados.payload : atual.payload;
        const novoMaxTentativas = dados.max_tentativas !== undefined ? Number(dados.max_tentativas) : atual.max_tentativas;

        const agoraIso = new Date().toISOString();

        const stmt = this.db.prepare(`
            UPDATE agendamentos
            SET descricao = ?,
                data_execucao = ?,
                timestamp_execucao = ?,
                url = ?,
                metodo = ?,
                headers = ?,
                payload = ?,
                max_tentativas = ?,
                status = 'PENDENTE',
                tentativas = 0,
                atualizado_em = ?
            WHERE id = ?
        `);

        stmt.run(
            novaDescricao,
            iso,
            timestamp,
            novaUrl,
            novoMetodo,
            JSON.stringify(novosHeaders),
            JSON.stringify(novoPayload),
            novoMaxTentativas,
            agoraIso,
            String(id)
        );

        console.log(`[Agendador] Agendamento '${id}' atualizado/reagendado para ${iso}`);
        this._recalcularTimer();

        return this.buscarPorId(id);
    }

    /**
     * Cancela um agendamento pelo ID.
     */
    cancelar(id) {
        const atual = this.buscarPorId(id);
        if (!atual) {
            return null;
        }

        const agoraIso = new Date().toISOString();
        const stmt = this.db.prepare(`
            UPDATE agendamentos
            SET status = 'CANCELADO',
                atualizado_em = ?
            WHERE id = ?
        `);
        stmt.run(agoraIso, String(id));

        console.log(`[Agendador] Agendamento '${id}' cancelado.`);
        this._recalcularTimer();

        return this.buscarPorId(id);
    }

    /**
     * Busca um agendamento pelo ID.
     */
    buscarPorId(id) {
        const stmt = this.db.prepare(`SELECT * FROM agendamentos WHERE id = ?`);
        const row = stmt.get(String(id));
        return this._formatarRegistro(row);
    }

    /**
     * Lista os agendamentos com filtro opcional por status.
     */
    listar({ status, limite = 100 } = {}) {
        let query = `SELECT * FROM agendamentos`;
        const params = [];

        if (status) {
            query += ` WHERE status = ?`;
            params.push(String(status).toUpperCase());
        }

        query += ` ORDER BY timestamp_execucao ASC LIMIT ?`;
        params.push(Number(limite) || 100);

        const stmt = this.db.prepare(query);
        const rows = stmt.all(...params);
        return rows.map((r) => this._formatarRegistro(r));
    }

    /**
     * Calcula o próximo agendamento PENDENTE e agenda o setTimeout para o milissegundo exato.
     */
    _recalcularTimer() {
        if (this.proximoTimer) {
            clearTimeout(this.proximoTimer);
            this.proximoTimer = null;
        }

        const stmt = this.db.prepare(`
            SELECT id, timestamp_execucao, data_execucao
            FROM agendamentos
            WHERE status = 'PENDENTE'
            ORDER BY timestamp_execucao ASC
            LIMIT 1
        `);
        const proximo = stmt.get();

        if (!proximo) {
            return;
        }

        const agora = Date.now();
        const atraso = proximo.timestamp_execucao - agora;

        if (atraso <= 0) {
            // Já chegou ou passou do horário: executa imediatamente no próximo tick
            this.proximoTimer = setTimeout(() => {
                this._processarVencidos();
            }, 0);
            return;
        }

        // Respeita o limite de 32-bits do setTimeout (~24,8 dias)
        const esperaSegura = Math.min(atraso, MAX_TIMEOUT_MS);

        this.proximoTimer = setTimeout(() => {
            if (atraso > MAX_TIMEOUT_MS) {
                this._recalcularTimer();
            } else {
                this._processarVencidos();
            }
        }, esperaSegura);
    }

    /**
     * Busca todos os agendamentos PENDENTES cujo horário já chegou e realiza os disparos HTTP.
     */
    async _processarVencidos() {
        if (this.emExecucao) return;
        this.emExecucao = true;

        try {
            const agora = Date.now();
            const stmt = this.db.prepare(`
                SELECT * FROM agendamentos
                WHERE status = 'PENDENTE' AND timestamp_execucao <= ?
                ORDER BY timestamp_execucao ASC
            `);
            const vencidos = stmt.all(agora);

            for (const item of vencidos) {
                await this._executarDisparo(item);
            }
        } catch (err) {
            console.error(`[Agendador] Erro ao processar fila de agendamentos:`, err);
        } finally {
            this.emExecucao = false;
            this._recalcularTimer();
        }
    }

    /**
     * Executa a chamada HTTP (Webhook) para o fluxo/regra do Maker.
     */
    async _executarDisparo(item) {
        const agoraIso = new Date().toISOString();

        // Marca como PROCESSANDO apenas se ainda estiver PENDENTE (evita disparo caso tenha sido cancelado)
        const lockStmt = this.db.prepare(`
            UPDATE agendamentos
            SET status = 'PROCESSANDO',
                tentativas = tentativas + 1,
                atualizado_em = ?
            WHERE id = ? AND status = 'PENDENTE'
        `);
        const info = lockStmt.run(agoraIso, item.id);
        if (info.changes === 0) {
            return;
        }

        const tentativaAtual = item.tentativas + 1;
        const headersCustom = this._safeJsonParse(item.headers, {});
        const payloadObj = this._safeJsonParse(item.payload, {});

        let urlFinal = item.url;
        const opcoesFetch = {
            method: item.metodo,
            headers: {
                'Accept': 'application/json, text/plain, */*',
                ...headersCustom
            },
            signal: AbortSignal.timeout(DEFAULT_HTTP_TIMEOUT_MS)
        };

        if (item.metodo === 'GET') {
            // Em requisições GET para regras do Webrun (.rule), anexa o payload como query params
            if (payloadObj && typeof payloadObj === 'object' && Object.keys(payloadObj).length > 0) {
                const parsedUrl = new URL(urlFinal);
                for (const [chave, valor] of Object.entries(payloadObj)) {
                    parsedUrl.searchParams.set(
                        chave,
                        typeof valor === 'object' ? JSON.stringify(valor) : String(valor)
                    );
                }
                urlFinal = parsedUrl.toString();
            }
        } else {
            if (!opcoesFetch.headers['Content-Type'] && !opcoesFetch.headers['content-type']) {
                opcoesFetch.headers['Content-Type'] = 'application/json';
            }

            const contentType = String(opcoesFetch.headers['Content-Type'] || opcoesFetch.headers['content-type']).toLowerCase();
            if (contentType.includes('application/x-www-form-urlencoded') && typeof payloadObj === 'object') {
                const params = new URLSearchParams();
                for (const [chave, valor] of Object.entries(payloadObj)) {
                    params.append(chave, typeof valor === 'object' ? JSON.stringify(valor) : String(valor));
                }
                opcoesFetch.body = params.toString();
            } else {
                opcoesFetch.body = typeof payloadObj === 'string' ? payloadObj : JSON.stringify(payloadObj);
            }
        }

        console.log(`[Agendador] Disparando '${item.id}' (Tentativa ${tentativaAtual}/${item.max_tentativas}) -> ${item.metodo} ${urlFinal}`);

        try {
            const response = await fetch(urlFinal, opcoesFetch);
            const textoResposta = await response.text();
            const respostaLimitada = textoResposta ? textoResposta.slice(0, 2000) : '';
            const concluidoIso = new Date().toISOString();

            if (response.ok) {
                const okStmt = this.db.prepare(`
                    UPDATE agendamentos
                    SET status = 'CONCLUIDO',
                        ultimo_status_http = ?,
                        ultima_resposta = ?,
                        executado_em = ?,
                        atualizado_em = ?
                    WHERE id = ?
                `);
                okStmt.run(response.status, respostaLimitada, concluidoIso, concluidoIso, item.id);
                console.log(`[Agendador] Sucesso no disparo '${item.id}' (HTTP ${response.status}).`);
            } else {
                throw new Error(`HTTP ${response.status}: ${respostaLimitada || response.statusText}`);
            }
        } catch (erro) {
            const msgErro = erro && erro.message ? erro.message : String(erro);
            const erroIso = new Date().toISOString();

            if (tentativaAtual < item.max_tentativas) {
                // Backoff exponencial: 15s na 1ª falha, 60s na 2ª, etc.
                const delayRetryMs = Math.min(15000 * Math.pow(4, tentativaAtual - 1), 300000);
                const novoTimestamp = Date.now() + delayRetryMs;
                const novaDataIso = new Date(novoTimestamp).toISOString();

                const retryStmt = this.db.prepare(`
                    UPDATE agendamentos
                    SET status = 'PENDENTE',
                        timestamp_execucao = ?,
                        ultima_resposta = ?,
                        atualizado_em = ?
                    WHERE id = ?
                `);
                retryStmt.run(novoTimestamp, `Falha na tentativa ${tentativaAtual}: ${msgErro}`, erroIso, item.id);

                console.warn(`[Agendador] Falha no disparo '${item.id}' (${msgErro}). Nova tentativa agendada para ${novaDataIso}.`);
            } else {
                const falhaStmt = this.db.prepare(`
                    UPDATE agendamentos
                    SET status = 'ERRO',
                        ultima_resposta = ?,
                        executado_em = ?,
                        atualizado_em = ?
                    WHERE id = ?
                `);
                falhaStmt.run(`Erro após ${tentativaAtual} tentativa(s): ${msgErro}`, erroIso, erroIso, item.id);

                console.error(`[Agendador] Agendamento '${item.id}' falhou definitivamente após ${tentativaAtual} tentativa(s): ${msgErro}`);
            }
        }
    }
}

module.exports = { AgendadorMaker };


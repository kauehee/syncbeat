# SyncBeat Studio

Produção musical colaborativa ao vivo no navegador: salas com relógio
compartilhado (sem streaming de áudio), sessão estilo Ableton (cenas/clipes),
arranjo em timeline, mixer com sends/retornos (reverb, delay), efeitos por
canal (EQ, compressor, distorção, filtro) e automação de parâmetros
(volume/pan) desenhada no arranjo.

## Rodando localmente

```
npm install
npm start
```

Acesse http://localhost:3000, informe um nome e um código de sala.
Compartilhe o link da sala para outros produtores entrarem.

## Estrutura

- `server.js` — servidor HTTP + WebSocket, estado das salas em memória.
- `public/index.html` — cliente (interface, áudio via Web Audio API).
- `public/legal.html` — Termos e Privacidade.

/**
 * Servidor SMTP mínimo (só para ensaios): aceita mensagens, guarda o MIME e extrai os anexos (base64) já descodificados.
 * A terminação da mensagem (`CRLF . CRLF`) pode chegar partida em vários pacotes TCP: procura-se sempre no acumulado.
 */
import net from "node:net";

export type AnexoRecebido = { filename: string; contentType: string; conteudo: Buffer };

export function iniciarSmtpSink(): Promise<{ port: number; mensagens: string[]; anexos: (desde?: number) => AnexoRecebido[]; fechar: () => void }> {
  const mensagens: string[] = [];
  const server = net.createServer((sock) => {
    if (process.env.SMTP_SINK_DEBUG) console.log("  [smtp] ligação");
    let emData = false;
    let dados = "";
    let buf = "";
    sock.write("220 sink ESMTP\r\n");
    const processar = () => {
      for (;;) {
        if (emData) {
          const fim = dados.indexOf("\r\n.\r\n");
          if (fim < 0) return;
          mensagens.push(dados.slice(0, fim));
          buf = dados.slice(fim + 5) + buf;
          dados = "";
          emData = false;
          sock.write("250 OK queued\r\n");
          continue;
        }
        const i = buf.indexOf("\r\n");
        if (i < 0) return;
        const linha = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const cmd = linha.toUpperCase();
        if (cmd.startsWith("EHLO") || cmd.startsWith("HELO")) sock.write("250 sink\r\n");
        else if (cmd.startsWith("DATA")) {
          emData = true;
          dados = buf;
          buf = "";
          sock.write("354 go\r\n");
        } else if (cmd.startsWith("QUIT")) {
          sock.write("221 bye\r\n");
          sock.end();
          return;
        } else sock.write("250 OK\r\n");
      }
    };
    sock.on("data", (d) => {
      const txt = d.toString("latin1");
      if (emData) dados += txt;
      else buf += txt;
      processar();
    });
    sock.on("error", () => undefined);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({
        port,
        mensagens,
        fechar: () => server.close(),
        anexos: (desde = 0) => {
          const out: AnexoRecebido[] = [];
          for (const m of mensagens.slice(desde)) {
            const partes = m.split(/\r\n--[^\r\n]+/);
            for (const p of partes) {
              const [cab, ...resto] = p.split("\r\n\r\n");
              const nome = /filename="?([^"\r\n;]+)"?/i.exec(cab)?.[1];
              if (!nome || !/base64/i.test(cab)) continue;
              out.push({ filename: nome, contentType: /Content-Type:\s*([^;\r\n]+)/i.exec(cab)?.[1] ?? "", conteudo: Buffer.from(resto.join("\r\n\r\n").replace(/\s+/g, ""), "base64") });
            }
          }
          return out;
        },
      });
    });
  });
}

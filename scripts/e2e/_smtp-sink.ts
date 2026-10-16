/**
 * Servidor SMTP mínimo (só para ensaios): aceita uma mensagem, guarda o MIME e extrai os anexos (base64) já descodificados.
 */
import net from "node:net";

export type AnexoRecebido = { filename: string; contentType: string; conteudo: Buffer };

export function iniciarSmtpSink(): Promise<{ port: number; mensagens: string[]; anexos: () => AnexoRecebido[]; fechar: () => void }> {
  const mensagens: string[] = [];
  const server = net.createServer((sock) => {
    let emData = false;
    let buf = "";
    let dados = "";
    sock.write("220 sink ESMTP\r\n");
    sock.on("data", (d) => {
      buf += d.toString("latin1");
      let i: number;
      if (emData) {
        const fim = buf.indexOf("\r\n.\r\n");
        if (fim >= 0) {
          dados += buf.slice(0, fim);
          mensagens.push(dados);
          buf = buf.slice(fim + 5);
          emData = false;
          dados = "";
          sock.write("250 OK queued\r\n");
        } else { dados += buf; buf = buf.slice(buf.length); }
        return;
      }
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const linha = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const cmd = linha.toUpperCase();
        if (cmd.startsWith("EHLO") || cmd.startsWith("HELO")) sock.write("250 sink\r\n");
        else if (cmd.startsWith("DATA")) { emData = true; sock.write("354 go\r\n"); if (buf) { dados = ""; const fim = buf.indexOf("\r\n.\r\n"); if (fim >= 0) { mensagens.push(buf.slice(0, fim)); buf = buf.slice(fim + 5); emData = false; sock.write("250 OK queued\r\n"); } else { dados = buf; buf = ""; } } break; }
        else if (cmd.startsWith("QUIT")) { sock.write("221 bye\r\n"); sock.end(); }
        else sock.write("250 OK\r\n");
      }
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
        anexos: () => {
          const out: AnexoRecebido[] = [];
          for (const m of mensagens) {
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

use mymind_core::ollama::{OllamaTransport, residency};
use serde_json::json;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn streams_visible_content_and_retains_tool_calls() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let (mut client, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut buffer = [0; 4096];
        loop {
            let n = client.read(&mut buffer).await.unwrap();
            assert!(n > 0);
            request.extend_from_slice(&buffer[..n]);
            if request.ends_with(b"}") {
                break;
            }
        }
        let request = String::from_utf8(request).unwrap();
        assert!(request.starts_with("POST /api/chat HTTP/1.1"));
        assert!(request.contains("\"stream\":true"));
        let body = concat!(
            "{\"message\":{\"thinking\":\"private\"}}\n",
            "{\"message\":{\"content\":\"Hello \"}}\n",
            "{\"message\":{\"content\":\"town hall\",\"tool_calls\":[{\"function\":{\"name\":\"find_items\"}}]}}\n",
            "{\"done\":true,\"eval_count\":12}"
        );
        let header = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", body.len());
        client.write_all(header.as_bytes()).await.unwrap();
        for chunk in body.as_bytes().chunks(17) {
            client.write_all(chunk).await.unwrap();
        }
    });
    let transport = OllamaTransport::new(port).unwrap();
    let mut visible = String::new();
    let result = transport
        .chat(
            json!({"model": "qwen3.5:4b"}),
            &CancellationToken::new(),
            Duration::from_secs(3),
            |chunk| visible.push_str(chunk),
        )
        .await
        .unwrap();
    assert_eq!(visible, "Hello town hall");
    assert_eq!(result["message"]["content"], visible);
    assert_eq!(result["message"]["thinking"], "private");
    assert_eq!(
        result["message"]["tool_calls"][0]["function"]["name"],
        "find_items"
    );
    assert_eq!(result["eval_count"], 12);
    assert_eq!(residency(&json!({"size": 100, "size_vram": 30})), "partial");
    server.await.unwrap();
}

#[tokio::test]
async fn cancellation_interrupts_a_pending_chat() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let token = CancellationToken::new();
    let server = tokio::spawn({
        let token = token.clone();
        async move {
            let (_client, _) = listener.accept().await.unwrap();
            token.cancel();
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    });
    let transport = OllamaTransport::new(port).unwrap();
    let result = transport
        .chat(
            json!({"model": "qwen3.5:4b"}),
            &token,
            Duration::from_secs(5),
            |_| {},
        )
        .await;
    assert!(result.unwrap_err().to_string().contains("stopped"));
    server.abort();
}

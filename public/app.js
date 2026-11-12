// ==========================================
  // STATE
  // ==========================================

  let currentConversationId = null;
  let isSending = false;


  // ==========================================
  // ELEMENTS
  // ==========================================

  const conversationList =
    document.getElementById("conversationList");

  const messages =
    document.getElementById("messages");

  const messageInput =
    document.getElementById("messageInput");

  const sendButton =
    document.getElementById("sendButton");

  const newChatButton =
    document.getElementById("newChatButton");

  const welcome =
    document.getElementById("welcome");

  const sidebar =
    document.getElementById("sidebar");

  const menuButton =
    document.getElementById("menuButton");

  const loginScreen =
    document.getElementById("authScreen");

  const authEmail =
    document.getElementById("authEmail");

  const authPassword =
    document.getElementById("authPassword");

  const authSubmit =
    document.getElementById("authSubmit");

  const authError =
    document.getElementById("authError");

  const authTitle =
    document.getElementById("authTitle");

  const authSubtitle =
    document.getElementById("authSubtitle");

  const authToggleText =
    document.getElementById("authToggleText");

  const authToggleLink =
    document.getElementById("authToggleLink");

  const logoutButton =
    document.getElementById("logoutButton");

  let authMode = "login";


  // ==========================================
  // LOAD CONVERSATIONS
  // ==========================================

  async function loadConversations() {

    try {

      const response =
        await fetch("/api/conversations");

      if (response.status === 401) {
        showAuthScreen();
        return;
      }

      if (!response.ok) {
        throw new Error("Failed to load conversations");
      }

      const conversations =
        await response.json();

      renderConversations(conversations);

    } catch (error) {

      console.error(error);

      conversationList.innerHTML = `
        <div class="empty-history">
          Failed to load conversations.
        </div>
      `;

    }

  }


  // ==========================================
  // RENDER CONVERSATIONS
  // ==========================================

  function renderConversations(conversations) {

    if (!conversations.length) {

      conversationList.innerHTML = `
        <div class="empty-history">
          No conversations yet.
        </div>
      `;

      return;
    }

    conversationList.innerHTML = "";

    conversations.forEach(conversation => {

      const item =
        document.createElement("div");

      item.className = "conversation";

      if (
        conversation.id === currentConversationId
      ) {
        item.classList.add("active");
      }

      item.textContent =
        conversation.title || "New conversation";

      item.title =
        conversation.title || "New conversation";

      item.addEventListener(
        "click",
        () => {
          openConversation(conversation.id);
        }
      );

      conversationList.appendChild(item);

    });

  }


  // ==========================================
  // OPEN CONVERSATION
  // ==========================================

  async function openConversation(id) {

    try {

      const response =
        await fetch(`/api/conversations/${id}`);

      if (response.status === 401) {
        showAuthScreen();
        return;
      }

      if (!response.ok) {
        throw new Error("Conversation not found");
      }

      const data =
        await response.json();

      currentConversationId = id;

      renderMessages(data.messages);

      await loadConversations();

      sidebar.classList.remove("open");

    } catch (error) {

      console.error(error);

      alert("Could not load this conversation.");

    }

  }


  // ==========================================
  // RENDER MESSAGES
  // ==========================================

  function renderMessages(messageList) {

    messages.innerHTML = "";

    const visibleMessages =
      messageList.filter(
        message => message.role !== "system"
      );

    if (!visibleMessages.length) {

      messages.appendChild(
        createWelcome()
      );

      return;

    }

    visibleMessages.forEach(message => {

      addMessageToUI(
        message.role,
        message.content
      );

    });

    scrollToBottom();

  }


  // ==========================================
  // WELCOME
  // ==========================================

  function createWelcome() {

    const div =
      document.createElement("div");

    div.className = "welcome";

    div.innerHTML = `
      <div class="welcome-content">
        <div class="welcome-icon">✨</div>

        <h1>
          How can WithUnion AI help you?
        </h1>

        <p>
          Ask me anything. Your conversations are saved automatically.
        </p>
      </div>
    `;

    return div;

  }


  // ==========================================
  // ADD MESSAGE TO UI
  // ==========================================

function addMessageToUI(role, content) {
  const message =
    document.createElement("div");
  message.className =
    `message ${role}`;
  const avatar =
    role === "user"
      ? "E"
      : "WU";
  const roleName =
    role === "user"
      ? "You"
      : "WithUnion AI";
  message.innerHTML = `
    <div class="avatar">
      ${avatar}
    </div>
    <div class="message-content">
      <div class="message-role">
        ${roleName}
      </div>
      <div class="message-text"></div>
    </div>
  `;
  const text =
    message.querySelector(".message-text");
  if (role === "assistant") {
    const rawHTML = marked.parse(content);
    const safeHTML = DOMPurify.sanitize(rawHTML);
    text.innerHTML = safeHTML;
    text.querySelectorAll("pre code").forEach(block => {
      hljs.highlightElement(block);
      const pre = block.parentElement;
      const wrapper = document.createElement("div");
      wrapper.className = "code-wrapper";
      pre.parentNode.insertBefore(wrapper, pre);
      wrapper.appendChild(pre);
      const copyButton = document.createElement("button");
      copyButton.className = "copy-code-button";
      copyButton.textContent = "Copy";
      copyButton.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(
            block.textContent
          );
          copyButton.textContent = "Copied!";
          setTimeout(() => {
            copyButton.textContent = "Copy";
          }, 1500);
        } catch (error) {
          console.error(
            "Copy failed:",
            error
          );
        }
      });
      wrapper.appendChild(copyButton);
    });
  } else {
    text.textContent = content;
  }
  messages.appendChild(message);
}

  // ==========================================
  // NEW CHAT
  // ==========================================

  async function newChat() {

    try {

      const response =
        await fetch(
          "/api/conversations",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            }
          }
        );

      if (response.status === 401) {
        showAuthScreen();
        return;
      }

      if (!response.ok) {
        throw new Error(
          "Failed to create conversation"
        );
      }

      const data =
        await response.json();

      currentConversationId =
        data.conversationId;

      messages.innerHTML = "";

      messages.appendChild(
        createWelcome()
      );

      messageInput.focus();

      await loadConversations();

    } catch (error) {

      console.error(error);

      alert("Could not create a new chat.");

    }

  }


  // ==========================================
  // SEND MESSAGE
  // ==========================================

  async function sendMessage() {

    const message =
      messageInput.value.trim();

    if (!message || isSending) {
      return;
    }

    isSending = true;

    sendButton.disabled = true;

    // Remove welcome screen
    const welcomeElement =
      messages.querySelector(".welcome");

    if (welcomeElement) {
      welcomeElement.remove();
    }

    // Add user message
    addMessageToUI(
      "user",
      message
    );

    messageInput.value = "";

    autoResize();

    scrollToBottom();

    // Typing indicator
    const typing =
      document.createElement("div");

    typing.className =
      "message assistant";

    typing.id =
      "typingIndicator";

    typing.innerHTML = `
      <div class="avatar">
        AI
      </div>

      <div class="message-content">

        <div class="message-role">
          WithUnion AI        
      </div>

        <div class="typing">
          <span></span>
          <span></span>
          <span></span>
        </div>

      </div>
    `;

    messages.appendChild(typing);

    scrollToBottom();


    try {

      const response =
        await fetch(
          "/api/chat",
          {
            method: "POST",

            headers: {
              "Content-Type": "application/json"
            },

            body: JSON.stringify({
              message,
              conversationId:
                currentConversationId
            })
          }
        );

      const data =
        await response.json();

      if (response.status === 401) {

        document
          .getElementById("typingIndicator")
          ?.remove();

        showAuthScreen();

        return;

      }

      if (!response.ok) {

        throw new Error(
          data.error ||
          "Request failed"
        );

      }

      // Save conversation ID
      currentConversationId =
        data.conversationId;

      // Remove typing indicator
      document
        .getElementById("typingIndicator")
        ?.remove();

      // Add AI response
      addMessageToUI(
        "assistant",
        data.answer
      );

      await loadConversations();

      scrollToBottom();

    } catch (error) {

      console.error(error);

      document
        .getElementById("typingIndicator")
        ?.remove();

      addMessageToUI(
        "assistant",
        "Sorry, something went wrong. Please try again."
      );

    } finally {

      isSending = false;

      sendButton.disabled = false;

      messageInput.focus();

    }

  }


  // ==========================================
  // SCROLL
  // ==========================================

  function scrollToBottom() {

    const chat =
      document.getElementById("chat");

    setTimeout(() => {

      chat.scrollTo({
        top: chat.scrollHeight,
        behavior: "smooth"
      });

    }, 50);

  }


  // ==========================================
  // AUTO RESIZE
  // ==========================================

  function autoResize() {

    messageInput.style.height =
      "auto";

    messageInput.style.height =
      Math.min(
        messageInput.scrollHeight,
        180
      ) + "px";

  }


  // ==========================================
  // EVENTS
  // ==========================================

  sendButton.addEventListener(
    "click",
    sendMessage
  );

  newChatButton.addEventListener(
    "click",
    newChat
  );

  messageInput.addEventListener(
    "input",
    autoResize
  );

  messageInput.addEventListener(
    "keydown",
    event => {

      if (
        event.key === "Enter" &&
        !event.shiftKey
      ) {

        event.preventDefault();

        sendMessage();

      }

    }
  );

  menuButton.addEventListener(
    "click",
    () => {

      sidebar.classList.toggle("open");

    }
  );


  // ==========================================
  // AUTH
  // ==========================================

  function showAuthScreen() {

    loginScreen.classList.add("open");

    setAuthMode("login");

    authPassword.value = "";

    authError.textContent = "";

    setTimeout(() => authEmail.focus(), 50);

  }

  function hideAuthScreen() {

    loginScreen.classList.remove("open");

  }

  function setAuthMode(mode) {

    authMode = mode;

    if (mode === "signup") {

      authTitle.textContent = "Create account";

      authSubtitle.textContent =
        "Choose an email and a password (8-72 characters).";

      authSubmit.textContent = "Sign up";

      authToggleText.textContent =
        "Already have an account?";

      authToggleLink.textContent = "Sign in";

      authPassword.setAttribute(
        "autocomplete",
        "new-password"
      );

    } else {

      authTitle.textContent = "Sign in";

      authSubtitle.textContent =
        "Sign in to continue to your conversations.";

      authSubmit.textContent = "Sign in";

      authToggleText.textContent =
        "Don't have an account?";

      authToggleLink.textContent = "Sign up";

      authPassword.setAttribute(
        "autocomplete",
        "current-password"
      );

    }

    authError.textContent = "";

  }

  async function submitAuth() {

    const email = authEmail.value.trim();

    const password = authPassword.value;

    if (!email || !password) {
      return;
    }

    authSubmit.disabled = true;

    authError.textContent = "";

    try {

      const response = await fetch(
        authMode === "signup" ? "/api/signup" : "/api/login",
        {
          method: "POST",

          headers: {
            "Content-Type": "application/json"
          },

          body: JSON.stringify({ email, password })
        }
      );

      const data = await response.json();

      if (!response.ok) {

        authError.textContent =
          data.error ||
          (authMode === "signup"
            ? "Sign up failed."
            : "Login failed.");

        return;

      }

      hideAuthScreen();

      await loadConversations();

      messageInput.focus();

    } catch (error) {

      authError.textContent =
        "Could not connect to the server.";

    } finally {

      authSubmit.disabled = false;

    }

  }

  async function logout() {

    try {

      await fetch("/api/logout", {
        method: "POST"
      });

    } catch (error) {

      console.error(error);

    }

    currentConversationId = null;

    messages.innerHTML = "";

    messages.appendChild(
      createWelcome()
    );

    showAuthScreen();

  }

  async function checkAuth() {

    try {

      const response = await fetch("/api/me");

      if (response.status === 401) {
        showAuthScreen();
        return;
      }

      await loadConversations();

    } catch (error) {

      console.error(error);

      showAuthScreen();

    }

  }

  authSubmit.addEventListener("click", submitAuth);

  authPassword.addEventListener(
    "keydown",
    event => {

      if (event.key === "Enter") {
        submitAuth();
      }

    }
  );

  authEmail.addEventListener(
    "keydown",
    event => {

      if (event.key === "Enter") {
        submitAuth();
      }

    }
  );

  authToggleLink.addEventListener(
    "click",
    event => {

      event.preventDefault();

      setAuthMode(
        authMode === "signup" ? "login" : "signup"
      );

      authPassword.value = "";

      setTimeout(() => authEmail.focus(), 50);

    }
  );

  logoutButton.addEventListener(
    "click",
    logout
  );

  // ==========================================
  // INITIALIZE
  // ==========================================

  checkAuth();

  messageInput.focus();

import pulsify = require("pulsifyy");
const manager = new pulsify.Manager({ send() {} });
manager.once(pulsify.ManagerEventTypes.NodeConnect, node => { void node.connected; });
void manager.handleShutdown();
